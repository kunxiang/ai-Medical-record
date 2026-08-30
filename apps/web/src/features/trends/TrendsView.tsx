import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  MetricGroupItemT, MetricGroupT, MetricSeriesSelectorT, ObservationT,
  TrendLineT, TrendPointT, TrendResponseT,
} from '@amr/contracts';
import {
  Activity, Archive, ArrowDown, ArrowUp, CalendarRange, Check, FileSearch,
  FolderPlus, Gauge, LoaderCircle, Plus, ShieldCheck, Trash2,
} from 'lucide-react';
import { uuidv7 } from 'uuidv7';
import type { Person } from '../../App.js';
import { api } from '../../api/client.js';
import type { BrowseSourceTarget } from '../browse/BrowseView.js';
import { ExportPanel } from '../exports/ExportPanel.js';
import { Alert } from '../../ui/Alert.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { Dialog } from '../../ui/Dialog.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Field } from '../../ui/Field.js';
import { Input } from '../../ui/Input.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { cn } from '../../ui/cn.js';

type Candidate = { key: string; label: string; selector: MetricSeriesSelectorT };

const SOURCE_LABEL: Record<TrendPointT['fact_source'], string> = {
  manual: '人工录入', imported: '人工导入', accepted_suggestion: '已确认建议', derived: '确定性派生',
};

function selectorOf(observation: ObservationT): MetricSeriesSelectorT | null {
  if (!observation.concept_code || !observation.series_key) return null;
  return {
    concept_code: observation.concept_code, qualifier: observation.qualifier,
    body_site: observation.body_site, specimen: observation.specimen,
    method: observation.method, device: observation.device,
    measurement_setting: observation.measurement_setting,
    extra_dims: observation.extra_dims, result_kind: observation.result_kind,
  };
}

function selectorLabel(selector: MetricSeriesSelectorT): string {
  const dimensions = [
    selector.specimen, selector.qualifier, selector.body_site, selector.method,
    selector.device, selector.measurement_setting,
  ].filter(Boolean);
  return `${selector.concept_code}${dimensions.length ? ` · ${dimensions.join(' · ')}` : ''}`;
}

function dateLabel(point: TrendPointT): string {
  if (point.observed_at) {
    return new Date(point.observed_at).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }
  return `${point.observed_on}（仅日期）`;
}

function pointSegments(points: TrendPointT[]): TrendPointT[][] {
  const segments: TrendPointT[][] = [];
  for (const point of points) {
    const current = segments.at(-1);
    const previous = current?.at(-1);
    const ambiguousSameDay = previous?.observed_on === point.observed_on
      && (!previous.observed_at || !point.observed_at);
    if (!current || ambiguousSameDay) segments.push([point]);
    else current.push(point);
  }
  return segments;
}

function TrendChart({ line }: { line: TrendLineT }): JSX.Element {
  const width = 720;
  const height = 220;
  const pad = 30;
  const values = line.points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max === min ? 1 : max - min;
  const times = line.points.map((point) => (
    point.observed_at ? Date.parse(point.observed_at) : Date.parse(`${point.observed_on}T00:00:00Z`)
  ));
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeSpan = maxTime === minTime ? 1 : maxTime - minTime;
  const xy = (point: TrendPointT) => {
    const time = point.observed_at
      ? Date.parse(point.observed_at) : Date.parse(`${point.observed_on}T00:00:00Z`);
    return {
      x: pad + ((time - minTime) / timeSpan) * (width - pad * 2),
      y: height - pad - ((point.value - min) / span) * (height - pad * 2),
    };
  };
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface-subtle/40 p-2" data-testid="trend-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[34rem] w-full" role="img" aria-label="指标趋势图">
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="currentColor" className="text-line-strong" />
        <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="currentColor" className="text-line-strong" />
        {line.comparable && pointSegments(line.points).map((segment, index) => (
          segment.length > 1 && (
            <polyline
              key={index} fill="none" stroke="currentColor" strokeWidth="3"
              strokeLinejoin="round" strokeLinecap="round" className="text-brand-500"
              points={segment.map((point) => {
                const pos = xy(point);
                return `${pos.x},${pos.y}`;
              }).join(' ')}
            />
          )
        ))}
        {line.points.map((point) => {
          const pos = xy(point);
          return (
            <circle
              key={point.observation_id} cx={pos.x} cy={pos.y} r="5"
              className={point.abnormal_flag && point.abnormal_flag !== 'normal'
                ? 'fill-warning stroke-white' : 'fill-brand-600 stroke-white'}
              strokeWidth="2"
            >
              <title>{`${dateLabel(point)} · ${point.value} ${point.unit ?? ''}`}</title>
            </circle>
          );
        })}
        <text x={pad} y={16} className="fill-muted text-[11px]">{max.toFixed(2)}</text>
        <text x={pad} y={height - 8} className="fill-muted text-[11px]">{min.toFixed(2)}</text>
      </svg>
    </div>
  );
}

function PointTable({
  line, onOpenSource,
}: {
  line: TrendLineT;
  onOpenSource: (target: BrowseSourceTarget) => void;
}): JSX.Element {
  const points = [...line.points].reverse().slice(0, 12);
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="min-w-[44rem] w-full text-left text-xs">
        <thead className="bg-surface-subtle text-muted">
          <tr>
            <th className="px-3 py-2 font-semibold">日期</th>
            <th className="px-3 py-2 font-semibold">结果</th>
            <th className="px-3 py-2 font-semibold">本报告参考</th>
            <th className="px-3 py-2 font-semibold">变化</th>
            <th className="px-3 py-2 font-semibold">事实来源</th>
            <th className="px-3 py-2 font-semibold">原件</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {points.map((point) => (
            <tr key={point.observation_id} className="bg-white align-top">
              <td className="px-3 py-2 whitespace-nowrap">{dateLabel(point)}</td>
              <td className="px-3 py-2 font-semibold">
                {point.value} {point.unit ?? ''}
                {point.abnormal_flag && point.abnormal_flag !== 'normal' && (
                  <Badge variant="warning" className="ml-2">{point.abnormal_flag}</Badge>
                )}
              </td>
              <td className="px-3 py-2">
                {point.reference.low !== null || point.reference.high !== null
                  ? `${point.reference.low ?? '—'} – ${point.reference.high ?? '—'} ${point.reference.unit ?? ''}`
                  : point.reference.text ?? '报告未提供'}
              </td>
              <td className="px-3 py-2">
                {point.rcv
                  ? <span>{point.rcv.change_percent}% · {point.rcv.exceeds ? '超过 RCV' : '未超过 RCV'} <small>{point.rcv.version}</small></span>
                  : <span className="text-muted">不可比较/数据不足</span>}
              </td>
              <td className="px-3 py-2">
                {SOURCE_LABEL[point.fact_source]}
                {point.calculation_version && <small className="block text-muted">{point.calculation_version}</small>}
              </td>
              <td className="px-3 py-2">
                {point.source_available && point.source_page?.current_document_id && point.source_page.current_page_no ? (
                  <button
                    type="button"
                    className="font-semibold text-brand-700 underline decoration-brand-300 underline-offset-2"
                    aria-label={`打开来源 ${point.observed_on}`}
                    onClick={() => onOpenSource({
                      documentId: point.source_page!.current_document_id!,
                      pageNo: point.source_page!.current_page_no!, bbox: point.source_page!.bbox,
                    })}
                  >
                    第 {point.source_page.current_page_no} 页
                  </button>
                ) : <Badge variant="warning">来源暂不可用</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupCreateDialog({
  open, candidates, saving, error, onClose, onCreate,
}: {
  open: boolean; candidates: Candidate[]; saving: boolean; error: string | null;
  onClose: () => void; onCreate: (name: string, keys: string[]) => void;
}): JSX.Element | null {
  const [name, setName] = useState('我的指标');
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => { if (open) setSelected([]); }, [open]);
  if (!open) return null;
  return (
    <Dialog open onClose={onClose} title="新建监控组" description="只列出已经映射且由人工确认的 series；不同标本和方法不会自动合并。" size="lg">
      <div className="space-y-4" data-testid="metric-group-create-dialog">
        {error && <Alert variant="danger"><span>{error}</span></Alert>}
        <Field label="监控组名称" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} />
        </Field>
        <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-line p-2">
          {candidates.map((candidate) => {
            const checked = selected.includes(candidate.key);
            return (
              <label key={candidate.key} className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm',
                checked ? 'border-brand-300 bg-brand-50' : 'border-line bg-white',
              )}>
                <input
                  type="checkbox" checked={checked} className="mt-1"
                  onChange={() => setSelected((current) => (
                    checked ? current.filter((key) => key !== candidate.key) : [...current, candidate.key]
                  ))}
                />
                <span><strong>{candidate.label}</strong><small className="mt-1 block text-muted">series {candidate.key.slice(0, 10)}…</small></span>
              </label>
            );
          })}
          {candidates.length === 0 && <p className="p-4 text-sm text-muted">还没有可加入的已确认、已映射指标。</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant="primary" loading={saving} disabled={!name.trim() || selected.length === 0}
            iconLeft={<Check size={16} />} onClick={() => onCreate(name.trim(), selected)}
          >创建监控组</Button>
        </div>
      </div>
    </Dialog>
  );
}

export function TrendsView({
  person, onOpenArchive, onOpenData, onOpenSource,
}: {
  person: Person | null; onOpenArchive: () => void; onOpenData: () => void;
  onOpenSource: (target: BrowseSourceTarget) => void;
}): JSX.Element {
  const [groups, setGroups] = useState<MetricGroupT[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trend, setTrend] = useState<TrendResponseT | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const refreshGroups = useCallback(async (preferId?: string) => {
    if (!person) return;
    const [groupResult, observationResult] = await Promise.all([
      api.metricGroups(person.id), api.observations(person.id, { limit: 100 }),
    ]);
    setGroups(groupResult.groups);
    const seen = new Set<string>();
    const nextCandidates: Candidate[] = [];
    for (const observation of observationResult.observations) {
      if (observation.result_kind === 'input_parameter' || !observation.series_key) continue;
      const selector = selectorOf(observation);
      if (!selector || seen.has(observation.series_key)) continue;
      seen.add(observation.series_key);
      nextCandidates.push({
        key: observation.series_key,
        label: `${observation.local_name} · ${selectorLabel(selector)}`,
        selector,
      });
    }
    setCandidates(nextCandidates);
    setSelectedId((current) => {
      const target = preferId ?? current;
      return groupResult.groups.some((group) => group.id === target)
        ? target! : groupResult.groups[0]?.id ?? null;
    });
  }, [person?.id]);

  useEffect(() => {
    if (!person) {
      setGroups([]); setCandidates([]); setSelectedId(null); setTrend(null);
      return;
    }
    setLoading(true); setError(null);
    void refreshGroups().catch((cause) => {
      setError(cause instanceof Error ? cause.message : '监控组加载失败');
    }).finally(() => setLoading(false));
  }, [person?.id, refreshGroups]);

  useEffect(() => {
    if (!selectedId) { setTrend(null); return; }
    let cancelled = false;
    setTrend(null); setLoading(true); setError(null);
    void api.metricGroupTrend(selectedId, {
      ...(from ? { from } : {}), ...(to ? { to } : {}),
      ...(cursor ? { cursor } : {}), limit: 1_000, max_points: 300,
    }).then((result) => {
      if (!cancelled) setTrend(result);
    }, (cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : '趋势加载失败');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, from, to, cursor]);

  const candidateByKey = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.key, candidate])), [candidates],
  );
  const activeGroup = groups.find((group) => group.id === selectedId) ?? null;

  const createCustom = async (name: string, keys: string[]) => {
    if (!person) return;
    setSaving(true); setError(null);
    try {
      const created = await api.createMetricGroup(person.id, {
        client_operation_id: uuidv7(), name, description: null, preset: null,
        items: keys.map((key) => ({ item_type: 'series', selector: candidateByKey.get(key)!.selector })),
      });
      setCreateOpen(false);
      await refreshGroups(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '监控组创建失败');
    } finally { setSaving(false); }
  };

  const createPreset = async () => {
    if (!person) return;
    setSaving(true); setError(null);
    try {
      const created = await api.createMetricGroup(person.id, {
        client_operation_id: uuidv7(), name: '三高+', description: '血压、血糖、血脂、尿酸与 BMI',
        preset: 'three_high_plus',
      });
      await refreshGroups(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '预设创建失败');
    } finally { setSaving(false); }
  };

  const saveOrder = async (items: MetricGroupItemT[]) => {
    if (!activeGroup) return;
    setSaving(true); setError(null);
    try {
      const updated = await api.patchMetricGroup(activeGroup.id, {
        client_operation_id: uuidv7(), if_revision: activeGroup.revision,
        items: items.map((item) => ({ item_type: 'series', selector: item.selector })),
      });
      await refreshGroups(updated.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '顺序保存失败');
    } finally { setSaving(false); }
  };

  const moveItem = (index: number, direction: -1 | 1) => {
    if (!activeGroup) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= activeGroup.items.length) return;
    const items = [...activeGroup.items];
    [items[index], items[nextIndex]] = [items[nextIndex]!, items[index]!];
    void saveOrder(items);
  };

  const archiveGroup = async () => {
    if (!activeGroup || !window.confirm(`归档监控组“${activeGroup.name}”？事实数据不会被删除。`)) return;
    setSaving(true); setError(null);
    try {
      await api.archiveMetricGroup(activeGroup.id, {
        client_operation_id: uuidv7(), if_revision: activeGroup.revision,
      });
      await refreshGroups();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '监控组归档失败');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-6" data-testid="trends-view">
      <PageHeader
        eyebrow="已确认数据" title={person ? `${person.display_name} 的趋势` : '指标趋势'}
        description="趋势只使用人工录入、人工确认或确定性派生的事实；未确认的智能建议不会进入图表。"
        action={<Badge variant="success" icon={<ShieldCheck size={13} />}>仅核心事实</Badge>}
      />
      {error && <Alert variant="danger" onClose={() => setError(null)}><span>{error}</span></Alert>}
      {!person ? (
        <EmptyState variant="card" icon={<Activity />} title="请先选择家庭成员" description="趋势严格按成员隔离。" />
      ) : loading && groups.length === 0 ? (
        <Card className="flex min-h-48 items-center justify-center gap-2 text-muted">
          <LoaderCircle className="animate-spin" /> 正在读取监控组…
        </Card>
      ) : groups.length === 0 ? (
        <Card className="border-brand-100 bg-gradient-to-br from-white to-brand-50/40">
          <EmptyState
            variant="default" icon={<Activity />} title="还没有监控组"
            description="先从已确认指标建立自己的监控组；也可以复制“三高+”预设，之后仍可自由调整。"
            action={<div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" iconLeft={<FolderPlus size={16} />} onClick={() => setCreateOpen(true)}>从已有指标创建</Button>
              <Button variant="soft" iconLeft={<Gauge size={16} />} loading={saving} onClick={() => void createPreset()}>复制“三高+”</Button>
              <Button variant="outline" iconLeft={<Archive size={16} />} onClick={onOpenArchive}>查看档案</Button>
            </div>}
          />
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="space-y-3" data-testid="metric-group-list">
            <Card className="p-3 md:p-3">
              <div className="mb-2 flex items-center justify-between px-1">
                <strong className="text-sm">监控组</strong>
                <button type="button" aria-label="新建监控组" onClick={() => setCreateOpen(true)} className="rounded-lg p-2 text-brand-700 hover:bg-brand-50"><Plus size={17} /></button>
              </div>
              <div className="space-y-1">
                {groups.map((group) => (
                  <button
                    key={group.id} type="button" onClick={() => { setSelectedId(group.id); setCursor(undefined); }}
                    className={cn(
                      'w-full rounded-xl px-3 py-2.5 text-left text-sm transition',
                      group.id === selectedId ? 'bg-brand-500 text-white shadow-sm' : 'hover:bg-brand-50',
                    )}
                  >
                    <strong className="block truncate">{group.name}</strong>
                    <small className={group.id === selectedId ? 'text-white/75' : 'text-muted'}>{group.items.length} 条 series</small>
                  </button>
                ))}
              </div>
              <Button className="mt-3" size="sm" fullWidth variant="soft" iconLeft={<Gauge size={14} />} loading={saving} onClick={() => void createPreset()}>
                复制“三高+”
              </Button>
            </Card>
          </aside>
          <section className="min-w-0 space-y-4">
            {activeGroup && (
              <Card className="space-y-4" data-testid="active-metric-group">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-xl font-bold">{activeGroup.name}</h2>
                      {activeGroup.preset_origin && <Badge variant="brand">来自“三高+”副本</Badge>}
                    </div>
                    <p className="mt-1 text-sm text-muted">{activeGroup.description ?? '用户自定义监控组'}</p>
                  </div>
                  <Button size="sm" variant="danger-soft" iconLeft={<Trash2 size={14} />} loading={saving} onClick={() => void archiveGroup()}>归档组</Button>
                </div>
                <div className="space-y-1 rounded-xl border border-line p-2">
                  {activeGroup.items.map((item, index) => (
                    <div key={item.id} className="flex items-center gap-2 rounded-lg bg-surface-subtle px-3 py-2 text-xs">
                      <span className="w-5 text-muted">{index + 1}</span>
                      <strong className="min-w-0 flex-1 truncate">{selectorLabel(item.selector)}</strong>
                      <button type="button" aria-label={`上移 ${selectorLabel(item.selector)}`} disabled={index === 0 || saving} onClick={() => moveItem(index, -1)} className="rounded p-1 hover:bg-white disabled:opacity-30"><ArrowUp size={14} /></button>
                      <button type="button" aria-label={`下移 ${selectorLabel(item.selector)}`} disabled={index === activeGroup.items.length - 1 || saving} onClick={() => moveItem(index, 1)} className="rounded p-1 hover:bg-white disabled:opacity-30"><ArrowDown size={14} /></button>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <Card className="space-y-4" data-testid="trend-result">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="开始日期" className="max-w-44"><Input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setCursor(undefined); }} /></Field>
                <Field label="结束日期" className="max-w-44"><Input type="date" value={to} onChange={(event) => { setTo(event.target.value); setCursor(undefined); }} /></Field>
                <Badge variant="neutral" icon={<CalendarRange size={13} />} data-testid="trend-total">
                  {trend ? `${trend.total_points} 个确认点` : '读取中'}
                </Badge>
                {trend?.downsampled && <Badge variant="warning">固定下采样 {trend.downsample_version}</Badge>}
              </div>
              {loading && !trend ? (
                <div className="flex min-h-40 items-center justify-center gap-2 text-muted"><LoaderCircle className="animate-spin" /> 正在生成确定性趋势…</div>
              ) : trend?.state === 'empty' ? (
                <EmptyState
                  icon={<Activity />} title="还没有已确认数据"
                  description="当前不会根据图片识别结果自动画趋势。请录入数据或先整理待映射指标。"
                  action={<Button variant="primary" onClick={onOpenData}>录入/整理数据</Button>}
                />
              ) : trend ? (
                <div className="space-y-6">
                  {trend.state === 'single' && <Alert variant="info" title="尚不能形成趋势"><span>当前只有 1 个确认点；仍保留该报告参考区间和原件来源。</span></Alert>}
                  {trend.series.map((series) => series.lines.map((line) => (
                    <section key={line.line_key} className="space-y-3" data-testid="trend-line">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-bold">{selectorLabel(series.selector)}</h3>
                        <Badge variant="neutral">{line.unit ?? '无单位'}</Badge>
                        <Badge variant={line.comparable ? 'success' : 'warning'}>{line.comparable ? '可比较' : '单位未验证，不连线'}</Badge>
                        <span className="text-xs text-muted">全量 {line.total_points} 点</span>
                      </div>
                      {line.points.length > 0 && <TrendChart line={line} />}
                      <PointTable line={line} onOpenSource={onOpenSource} />
                    </section>
                  )))}
                  {trend.overlays.length > 0 && (
                    <section className="rounded-xl border border-line bg-surface-subtle/50 p-4" data-testid="trend-overlays">
                      <h3 className="mb-2 font-bold">同期情境事实</h3>
                      <p className="mb-3 text-xs text-muted">仅按时间叠加用户已记录事实，不解释因果。</p>
                      <div className="space-y-2">
                        {trend.overlays.map((overlay) => (
                          <div key={overlay.id} className="flex gap-3 text-sm"><span className="whitespace-nowrap text-muted">{overlay.occurred_on}</span><span>{overlay.label}</span></div>
                        ))}
                      </div>
                    </section>
                  )}
                  {trend.next_cursor && (
                    <Alert variant="info" icon={<FileSearch size={18} />} title="还有更多数据"><span>当前按稳定游标显示一页；<button type="button" className="ml-1 font-semibold underline" onClick={() => setCursor(trend.next_cursor ?? undefined)}>查看下一页</button></span></Alert>
                  )}
                </div>
              ) : null}
            </Card>
          </section>
        </div>
      )}
      <ExportPanel key={person?.id ?? 'no-person'} person={person} />
      <GroupCreateDialog
        open={createOpen} candidates={candidates} saving={saving} error={error}
        onClose={() => setCreateOpen(false)} onCreate={(name, keys) => void createCustom(name, keys)}
      />
    </div>
  );
}
