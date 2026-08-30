import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AccessRoleT, ExportJobT, ExportPreviewResponseT, ExportSelectionT, ExportShareT, MetricGroupT,
} from '@amr/contracts';
import {
  Clipboard, Download, Eye, FileImage, FileText, Link2, LoaderCircle,
  RefreshCw, RotateCcw, Share2, ShieldCheck, Trash2,
} from 'lucide-react';
import { uuidv7 } from 'uuidv7';
import type { Person } from '../../App.js';
import { api, ApiFailure, sharedExportUrl } from '../../api/client.js';
import { Alert } from '../../ui/Alert.js';
import { Badge, type BadgeVariant } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { Dialog } from '../../ui/Dialog.js';
import { Field } from '../../ui/Field.js';
import { Input } from '../../ui/Input.js';
import { Select } from '../../ui/Select.js';
import { exportActionPolicy } from './export-action-policy.js';

interface ExportForm {
  metricGroupIds: string[];
  from: string;
  to: string;
  includeEvents: boolean;
  includeUndatedEvents: boolean;
  includeOriginals: boolean;
  format: 'pdf' | 'png';
}

const INITIAL_FORM: ExportForm = {
  metricGroupIds: [], from: '', to: '', includeEvents: true,
  includeUndatedEvents: true, includeOriginals: false, format: 'pdf',
};

const ROLE_LABEL: Record<AccessRoleT, string> = {
  owner: '所有者', editor: '编辑者', viewer: '只读成员',
};

const STATE_LABEL: Record<ExportJobT['state'], string> = {
  pending: '等待生成', running: '生成中', done: '已完成', failed: '生成失败',
};

const STATE_VARIANT: Record<ExportJobT['state'], BadgeVariant> = {
  pending: 'neutral', running: 'info', done: 'success', failed: 'danger',
};

function formSelection(personId: string, form: ExportForm): ExportSelectionT {
  return {
    person_id: personId,
    metric_group_ids: form.metricGroupIds,
    from: form.from || null,
    to: form.to || null,
    include_events: form.includeEvents,
    include_undated_events: form.includeUndatedEvents,
    include_originals: form.includeOriginals,
    format: form.format,
  };
}

function formFromSelection(selection: ExportSelectionT): ExportForm {
  return {
    metricGroupIds: selection.metric_group_ids,
    from: selection.from ?? '', to: selection.to ?? '',
    includeEvents: selection.include_events,
    includeUndatedEvents: selection.include_undated_events,
    includeOriginals: selection.include_originals,
    format: selection.format,
  };
}

function dateTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function dateRange(selection: ExportSelectionT): string {
  return `${selection.from ?? '最早记录'} 至 ${selection.to ?? '最新记录'}`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function PreviewCard({ preview }: { preview: ExportPreviewResponseT }): JSX.Element {
  const factCount = preview.metrics.length + preview.events.length;
  return (
    <Card className="space-y-4 border-brand-200" data-testid="export-preview-result">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Eye size={18} className="text-brand-600" />
            <h3 className="font-bold">生成前预览</h3>
          </div>
          <p className="mt-1 text-xs text-muted">{dateRange(preview.selection)} · {preview.estimated_pages} 页估算</p>
        </div>
        <Badge variant={preview.can_generate && factCount > 0 ? 'success' : 'warning'}>
          {preview.can_generate && factCount > 0 ? '可以生成' : '需要调整'}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl bg-surface-subtle p-3"><strong className="block text-lg">{preview.counts.metric_series}</strong><span className="text-xs text-muted">指标序列</span></div>
        <div className="rounded-xl bg-surface-subtle p-3"><strong className="block text-lg">{preview.counts.observations}</strong><span className="text-xs text-muted">确认结果</span></div>
        <div className="rounded-xl bg-surface-subtle p-3"><strong className="block text-lg">{preview.events.length}</strong><span className="text-xs text-muted">时间轴事件</span></div>
        <div className="rounded-xl bg-surface-subtle p-3"><strong className="block text-lg">{preview.counts.original_pages}</strong><span className="text-xs text-muted">原件页</span></div>
      </div>

      {preview.metrics.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-bold text-ink-secondary">一页纸首屏指标</h4>
          <div className="grid gap-2 sm:grid-cols-2">
            {preview.metrics.slice(0, 8).map((metric) => (
              <div key={metric.group_item_id} className="rounded-xl border border-line px-3 py-2 text-xs">
                <strong className="block truncate">{metric.metric_group_name} · {metric.series_label}</strong>
                <span className="mt-1 block text-sm font-bold text-brand-800">{metric.latest.value}</span>
                <span className="text-muted">{metric.change ?? '暂无可比较的前值'} · {metric.latest.observed_on}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {preview.events.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-bold text-ink-secondary">事件时间轴</h4>
          <div className="max-h-48 space-y-2 overflow-y-auto rounded-xl border border-line p-3">
            {preview.events.slice(0, 12).map((event) => (
              <div key={`${event.source_type}:${event.source_id}`} className="flex gap-3 text-xs">
                <span className="w-24 shrink-0 text-muted">{event.occurred_at ? dateTime(event.occurred_at) : event.occurred_on ?? '日期未记录'}</span>
                <span className="min-w-0 flex-1">{event.label}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {preview.gaps.length > 0 && (
        <Alert variant="warning" title={`${preview.gaps.length} 项数据缺口`}>
          <ul className="list-disc space-y-1 pl-4">
            {preview.gaps.slice(0, 8).map((gap, index) => <li key={`${gap.code}:${gap.subject_id ?? index}`}>{gap.message}</li>)}
          </ul>
        </Alert>
      )}
      <Alert variant="info" title="只呈现事实和来源">
        <span>摘要不会生成诊断、治疗或用药建议，也不会把未确认的智能建议写入导出。</span>
      </Alert>
    </Card>
  );
}

function ShareDialog({
  person, job, shares, loading, onClose, onReload,
}: {
  person: Person; job: ExportJobT; shares: ExportShareT[]; loading: boolean;
  onClose: () => void; onReload: () => Promise<void>;
}): JSX.Element {
  const [expiresIn, setExpiresIn] = useState(86_400);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = async () => {
    if (!confirmed) return;
    setBusy(true); setError(null); setCreatedUrl(null); setCopied(false);
    try {
      const result = await api.createExportShare(job.id, {
        client_operation_id: uuidv7(), expires_in_seconds: expiresIn,
        source_revision_hash: job.source_revision_hash, confirmed: true,
      });
      if (!result.token) throw new Error('安全链接只在首次创建时显示，请新建一条分享。');
      setCreatedUrl(sharedExportUrl(result.token));
      await onReload();
    } catch (cause) {
      setError(cause instanceof ApiFailure && cause.code === 'revision_conflict'
        ? '导出版本已变化，请关闭窗口并重新确认当前摘要。'
        : cause instanceof Error ? cause.message : '创建分享失败');
    } finally { setBusy(false); }
  };

  const copy = async () => {
    if (!createdUrl) return;
    try {
      await navigator.clipboard.writeText(createdUrl);
      setCopied(true);
    } catch {
      setError('浏览器未允许复制，请手动选中链接复制。');
    }
  };

  const revoke = async (share: ExportShareT) => {
    if (!window.confirm('撤销后，该公开链接会立即变为不可用。是否继续？')) return;
    setBusy(true); setError(null);
    try {
      await api.revokeExportShare(job.id, share.id, { client_operation_id: uuidv7() });
      await onReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '撤销分享失败');
    } finally { setBusy(false); }
  };

  return (
    <Dialog open onClose={onClose} title="创建公开就诊摘要链接" description="公开链接无需登录即可访问，请只发给预期接收人。" icon={<Share2 />} size="lg">
      <div className="space-y-5" data-testid="export-share-dialog">
        {error && <Alert variant="danger"><span>{error}</span></Alert>}
        <dl className="grid gap-2 rounded-xl border border-line bg-surface-subtle p-4 text-xs sm:grid-cols-2">
          <div><dt className="text-muted">档案人员</dt><dd className="mt-1 font-bold">{person.display_name}</dd></div>
          <div><dt className="text-muted">数据范围</dt><dd className="mt-1 font-bold">{dateRange(job.request)}</dd></div>
          <div><dt className="text-muted">摘要内容</dt><dd className="mt-1 font-bold">趋势、事件{job.request.include_originals ? '、原件附录' : ''}</dd></div>
          <div><dt className="text-muted">文件格式</dt><dd className="mt-1 font-bold">{job.request.format.toUpperCase()}</dd></div>
        </dl>
        {job.stale && <Alert variant="warning" title="这份摘要生成后数据已有更新"><span>仍可分享历史快照，但建议先生成新版并重新核对。</span></Alert>}
        <Alert variant="warning" title="公开链接风险">
          <span>知道链接的人都可以在到期前打开医疗摘要。系统不会在数据库中保存可恢复的明文链接；链接也只会在创建成功后显示一次。</span>
        </Alert>
        <Field label="有效期">
          <Select value={expiresIn} onChange={(event) => setExpiresIn(Number(event.target.value))}>
            <option value={3_600}>1 小时</option>
            <option value={86_400}>24 小时</option>
            <option value={259_200}>3 天</option>
            <option value={604_800}>7 天</option>
          </Select>
        </Field>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 text-sm">
          <input data-testid="export-share-confirm" type="checkbox" className="mt-1" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>我已核对人员、日期范围、摘要内容和有效期，并理解公开链接的访问风险。</span>
        </label>
        <Button data-testid="export-share-create" fullWidth variant="primary" iconLeft={<Link2 size={16} />} loading={busy} disabled={!confirmed} onClick={() => void create()}>
          创建一次性显示的分享链接
        </Button>

        {createdUrl && (
          <Alert variant="success" title="请现在复制；关闭后无法再次查看">
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input readOnly value={createdUrl} aria-label="公开分享链接" className="min-w-0 flex-1 rounded-lg border border-success-border bg-white px-3 py-2 text-xs text-ink" onFocus={(event) => event.currentTarget.select()} />
              <Button size="sm" variant="secondary" iconLeft={<Clipboard size={14} />} onClick={() => void copy()}>{copied ? '已复制' : '复制链接'}</Button>
            </div>
          </Alert>
        )}

        <section className="space-y-2">
          <h3 className="font-bold">分享历史</h3>
          {loading ? <p className="text-sm text-muted">正在读取…</p> : shares.length === 0 ? (
            <p className="rounded-xl bg-surface-subtle p-4 text-sm text-muted">尚未创建公开分享。</p>
          ) : shares.map((share) => {
            const expired = Date.parse(share.expires_at) <= Date.now();
            const active = !share.revoked_at && !expired;
            return (
              <div key={share.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3 text-xs">
                <div>
                  <div className="flex items-center gap-2"><Badge variant={active ? 'success' : 'neutral'}>{active ? '有效' : share.revoked_at ? '已撤销' : '已过期'}</Badge><span>到期 {dateTime(share.expires_at)}</span></div>
                  <p className="mt-1 text-muted">访问 {share.access_count} 次 · 最近 {dateTime(share.last_accessed_at)}</p>
                </div>
                {active && <Button size="sm" variant="danger-soft" iconLeft={<Trash2 size={14} />} loading={busy} onClick={() => void revoke(share)}>撤销</Button>}
              </div>
            );
          })}
        </section>
      </div>
    </Dialog>
  );
}

export function ExportPanel({ person }: { person: Person | null }): JSX.Element | null {
  const [role, setRole] = useState<AccessRoleT | null>(null);
  const [groups, setGroups] = useState<MetricGroupT[]>([]);
  const [jobs, setJobs] = useState<ExportJobT[]>([]);
  const [form, setForm] = useState<ExportForm>(INITIAL_FORM);
  const [preview, setPreview] = useState<ExportPreviewResponseT | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<ExportJobT | null>(null);
  const [shares, setShares] = useState<ExportShareT[]>([]);
  const [shareLoading, setShareLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    if (!person) return null;
    const result = await api.exports(person.id);
    setRole(result.access_role);
    setJobs(result.exports);
    return result.access_role;
  }, [person?.id]);

  useEffect(() => {
    setRole(null); setGroups([]); setJobs([]); setForm(INITIAL_FORM);
    setPreview(null); setError(null); setShareTarget(null); setShares([]);
    if (!person) return;
    let cancelled = false;
    setLoading(true);
    void api.exports(person.id).then(async (history) => {
      if (cancelled) return;
      setRole(history.access_role); setJobs(history.exports);
      if (history.access_role !== 'viewer') {
        const result = await api.metricGroups(person.id);
        if (!cancelled) setGroups(result.groups);
      }
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : '导出历史加载失败');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [person?.id]);

  const activeIds = useMemo(
    () => jobs.filter((job) => job.state === 'pending' || job.state === 'running').map((job) => job.id), [jobs],
  );
  const activeKey = activeIds.join(',');
  useEffect(() => {
    if (!activeKey) return;
    const timer = window.setTimeout(() => {
      void Promise.all(activeIds.map((id) => api.exportJob(id))).then((updates) => {
        const byId = new Map(updates.map((job) => [job.id, job]));
        setJobs((current) => current.map((job) => byId.get(job.id) ?? job));
      }).catch((cause) => setError(cause instanceof Error ? cause.message : '导出进度刷新失败'));
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [activeKey, jobs]);

  if (!person) return null;
  const selection = formSelection(person.id, form);
  const previewHasFacts = Boolean(preview && (preview.metrics.length > 0 || preview.events.length > 0));

  const runPreview = async () => {
    setBusy('preview'); setError(null); setPreview(null);
    try { setPreview(await api.exportPreview(selection)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '导出预览失败'); }
    finally { setBusy(null); }
  };

  const generate = async () => {
    setBusy('generate'); setError(null);
    try {
      const created = await api.createVisitSummary({ ...selection, client_operation_id: uuidv7() });
      setJobs((current) => [created, ...current.filter((job) => job.id !== created.id)]);
      setPreview(null);
    } catch (cause) {
      setError(cause instanceof ApiFailure && cause.code === 'export_too_large'
        ? '原件附录超过上限，请取消原件或缩小日期范围后重新预览。'
        : cause instanceof Error ? cause.message : '创建导出失败');
    } finally { setBusy(null); }
  };

  const download = async (job: ExportJobT) => {
    setBusy(`download:${job.id}`); setError(null);
    try {
      const file = await api.downloadExport(job.id);
      triggerDownload(file.blob, file.filename);
    }
    catch (cause) {
      setError(cause instanceof ApiFailure && cause.code === 'export_artifact_missing'
        ? '导出文件对象已丢失，请点击“重新生成文件”。'
        : cause instanceof Error ? cause.message : '下载失败');
    } finally { setBusy(null); }
  };

  const retry = async (job: ExportJobT) => {
    setBusy(`retry:${job.id}`); setError(null);
    try {
      const updated = await api.retryExport(job.id, { client_operation_id: uuidv7() });
      setJobs((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '重新生成失败'); }
    finally { setBusy(null); }
  };

  const previewNewVersion = (job: ExportJobT) => {
    setForm(formFromSelection(job.request));
    setPreview(null);
    document.getElementById('visit-summary-builder')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const openShare = async (job: ExportJobT) => {
    setShareTarget(job); setShares([]); setShareLoading(true); setError(null);
    try { setShares((await api.exportShares(job.id)).shares); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '分享历史加载失败'); }
    finally { setShareLoading(false); }
  };

  const reloadShares = async () => {
    if (!shareTarget) return;
    setShares((await api.exportShares(shareTarget.id)).shares);
  };

  return (
    <section className="space-y-4" data-testid="export-panel">
      <Card id="visit-summary-builder" className="space-y-5 scroll-mt-24">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><FileText size={20} className="text-brand-600" /><h2 className="text-lg font-bold">就诊摘要导出</h2></div>
            <p className="mt-1 text-sm text-muted">确定性生成一页纸趋势与事件时间轴，可选原件附录。</p>
          </div>
          {role && <Badge variant="neutral" icon={<ShieldCheck size={13} />}>{ROLE_LABEL[role]}</Badge>}
        </div>
        {error && <Alert variant="danger" onClose={() => setError(null)}><span>{error}</span></Alert>}
        {loading ? (
          <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-muted"><LoaderCircle className="animate-spin" />正在读取导出能力…</div>
        ) : !role ? (
          <Alert variant="warning" title="暂时无法确认导出权限"><span>请刷新后重试；系统不会在权限未知时开放生成或分享。</span></Alert>
        ) : role === 'viewer' ? (
          <Alert variant="info" title="只读权限"><span>你可以查看并下载已完成的内部摘要；只有编辑者或所有者可以生成新版，只有所有者可以公开分享。</span></Alert>
        ) : (
          <div className="space-y-4" data-testid="export-builder">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="开始日期"><Input type="date" value={form.from} onChange={(event) => { setForm((value) => ({ ...value, from: event.target.value })); setPreview(null); }} /></Field>
              <Field label="结束日期"><Input type="date" value={form.to} onChange={(event) => { setForm((value) => ({ ...value, to: event.target.value })); setPreview(null); }} /></Field>
              <Field label="文件格式"><Select value={form.format} onChange={(event) => { setForm((value) => ({ ...value, format: event.target.value as 'pdf' | 'png' })); setPreview(null); }}><option value="pdf">PDF（推荐）</option><option value="png">PNG 图片</option></Select></Field>
            </div>
            <Field label="监控组" hint="不勾选表示包含全部监控组；不同 series 仍保持分线。">
              <div className="flex flex-wrap gap-2 rounded-xl border border-line p-3">
                {groups.length === 0 ? <span className="text-sm text-muted">暂无监控组，仍可只导出事件时间轴。</span> : groups.map((group) => {
                  const checked = form.metricGroupIds.includes(group.id);
                  return <label key={group.id} className="flex cursor-pointer items-center gap-2 rounded-lg bg-surface-subtle px-3 py-2 text-xs"><input type="checkbox" checked={checked} onChange={() => { setForm((value) => ({ ...value, metricGroupIds: checked ? value.metricGroupIds.filter((id) => id !== group.id) : [...value.metricGroupIds, group.id] })); setPreview(null); }} />{group.name}</label>;
                })}
              </div>
            </Field>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="flex items-center gap-2 rounded-xl border border-line p-3 text-sm"><input type="checkbox" checked={form.includeEvents} onChange={(event) => { setForm((value) => ({ ...value, includeEvents: event.target.checked })); setPreview(null); }} />就诊、用药与情境事件</label>
              <label className="flex items-center gap-2 rounded-xl border border-line p-3 text-sm"><input type="checkbox" checked={form.includeUndatedEvents} disabled={!form.includeEvents} onChange={(event) => { setForm((value) => ({ ...value, includeUndatedEvents: event.target.checked })); setPreview(null); }} />包含“日期未记录”</label>
              <label className="flex items-center gap-2 rounded-xl border border-line p-3 text-sm"><input type="checkbox" checked={form.includeOriginals} onChange={(event) => { setForm((value) => ({ ...value, includeOriginals: event.target.checked })); setPreview(null); }} />附带目标人员原件</label>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" iconLeft={<Eye size={16} />} loading={busy === 'preview'} onClick={() => void runPreview()}>预览范围与缺口</Button>
              <Button variant="primary" iconLeft={form.format === 'pdf' ? <FileText size={16} /> : <FileImage size={16} />} loading={busy === 'generate'} disabled={!preview?.can_generate || !previewHasFacts} onClick={() => void generate()}>确认预览后生成</Button>
            </div>
          </div>
        )}
      </Card>

      {preview && <PreviewCard preview={preview} />}

      <Card className="space-y-4" data-testid="export-history">
        <div className="flex items-center justify-between gap-3"><div><h2 className="font-bold">导出历史</h2><p className="text-xs text-muted">历史文件保持原快照；数据变化后会明确标记，不会被静默覆盖。</p></div><Button size="sm" variant="ghost" iconLeft={<RefreshCw size={14} />} onClick={() => void loadHistory()}>刷新</Button></div>
        {jobs.length === 0 ? <p className="rounded-xl bg-surface-subtle p-4 text-sm text-muted">还没有导出记录。</p> : (
          <div className="space-y-3">
            {jobs.map((job) => (
              <article key={job.id} className="space-y-3 rounded-xl border border-line p-4" data-testid="export-history-item">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2"><Badge variant={STATE_VARIANT[job.state]}>{STATE_LABEL[job.state]}</Badge><Badge variant="neutral">{job.request.format.toUpperCase()}</Badge>{job.stale && <Badge variant="warning">生成后数据有更新</Badge>}</div>
                    <p className="mt-2 text-sm font-semibold">{dateRange(job.request)}</p>
                    <p className="mt-1 text-xs text-muted">创建 {dateTime(job.created_at)} · renderer {job.renderer_version} · attempt {job.attempt}/{job.max_attempts}</p>
                  </div>
                  <span className="text-xs text-muted">{job.result_byte_size !== null ? `${Math.ceil(job.result_byte_size / 1024)} KiB` : `${job.progress}%`}</span>
                </div>
                {(job.state === 'pending' || job.state === 'running') && <div className="h-2 overflow-hidden rounded-full bg-surface-subtle"><div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${Math.max(job.progress, 4)}%` }} /></div>}
                {job.last_error && <Alert variant="danger" title={job.last_error.code}><span>{job.last_error.message}</span></Alert>}
                {job.stale && <Alert variant="warning"><span>这份历史摘要仍可下载；如需当前数据，请重新预览并生成新版。</span></Alert>}
                <div className="flex flex-wrap gap-2">
                  {exportActionPolicy(role, job).canDownload && <Button data-testid="export-download" size="sm" variant="primary" iconLeft={<Download size={14} />} loading={busy === `download:${job.id}`} onClick={() => void download(job)}>下载</Button>}
                  {exportActionPolicy(role, job).canRetry && <Button size="sm" variant="soft" iconLeft={<RotateCcw size={14} />} loading={busy === `retry:${job.id}`} onClick={() => void retry(job)}>{job.state === 'failed' ? '重试' : '重新生成文件'}</Button>}
                  {exportActionPolicy(role, job).canRegenerateStale && <Button size="sm" variant="secondary" iconLeft={<RefreshCw size={14} />} onClick={() => previewNewVersion(job)}>按当前数据生成新版</Button>}
                  {exportActionPolicy(role, job).canShare && <Button data-testid="export-share-open" size="sm" variant="outline" iconLeft={<Share2 size={14} />} onClick={() => void openShare(job)}>分享与撤销</Button>}
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>

      {shareTarget && <ShareDialog person={person} job={shareTarget} shares={shares} loading={shareLoading} onClose={() => { setShareTarget(null); setShares([]); }} onReload={reloadShares} />}
    </section>
  );
}
