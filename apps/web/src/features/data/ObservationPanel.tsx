import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ObservationPatchRequest,
  type DocumentDetailResponseT, type EncounterT, type MedicalConceptT,
  type ObservationMappingInboxResponseT, type ObservationSuggestionT, type ObservationT,
} from '@amr/contracts';
import {
  Activity, AlertTriangle, Archive, Edit3, ExternalLink, Link2, LoaderCircle,
  Plus, Save, Search, ShieldAlert, ShieldCheck, ShieldQuestion, WandSparkles,
} from 'lucide-react';
import { uuidv7 } from 'uuidv7';
import type { Person } from '../../App.js';
import { api, ApiFailure } from '../../api/client.js';
import { Alert } from '../../ui/Alert.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { Dialog } from '../../ui/Dialog.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Field } from '../../ui/Field.js';
import { Input } from '../../ui/Input.js';
import { Select } from '../../ui/Select.js';
import { ObservationWorkbench } from './ObservationWorkbench.js';

function valueLabel(value: ObservationT): string {
  const comparator = value.comparator && value.comparator !== '=' ? value.comparator : '';
  const result = value.value_num !== null ? `${comparator}${value.value_num}`
    : value.value_text ?? value.value_raw;
  return `${result}${value.unit_raw ? ` ${value.unit_raw}` : ''}`;
}

function abnormalVariant(value: ObservationT): 'danger' | 'warning' | 'success' | 'neutral' {
  if (value.abnormal_flag === 'critical_low' || value.abnormal_flag === 'critical_high') return 'danger';
  if (value.abnormal_flag === 'high' || value.abnormal_flag === 'low') return 'warning';
  if (value.abnormal_flag === 'normal') return 'success';
  return 'neutral';
}

interface EditDraft {
  value_raw: string;
  unit_raw: string;
  ref_low: string;
  ref_high: string;
  ref_text: string;
  correction_note: string;
}

function editDraft(value: ObservationT): EditDraft {
  return {
    value_raw: value.value_raw, unit_raw: value.unit_raw ?? '',
    ref_low: value.ref_low === null ? '' : String(value.ref_low),
    ref_high: value.ref_high === null ? '' : String(value.ref_high),
    ref_text: value.ref_text ?? '', correction_note: '',
  };
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}


/**
 * 可信度徽章(ADR-054)。让"这个数字凭什么可信"一眼可见。
 * confirmed/corrected 不出徽章 —— 那是人工录入或人工修正的默认情形。
 */
const VERIFICATION_BADGE: Partial<Record<string, {
  label: string; variant: 'info' | 'warning' | 'danger'; icon: JSX.Element;
}>> = {
  machine_verified: {
    label: '机器校验', variant: 'info', icon: <ShieldCheck size={12} />,
  },
  unverified: {
    // 提取出来了,但单据上没有可交叉验算的冗余 —— 没有人、也没有机器核对过。
    label: '未经验证', variant: 'warning', icon: <ShieldQuestion size={12} />,
  },
  check_failed: {
    // 自洽等式没算平:该行或同一等式里的另一行很可能读错了。
    label: '校验未通过', variant: 'danger', icon: <ShieldAlert size={12} />,
  },
};

export function ObservationPanel({
  person, encounters, detail = null, compact = false, onOpenSource,
}: {
  person: Pick<Person, 'id' | 'display_name'>;
  encounters: EncounterT[];
  detail?: DocumentDetailResponseT | null;
  compact?: boolean;
  onOpenSource?: (documentId: string, pageNo: number) => void;
}): JSX.Element {
  const [observations, setObservations] = useState<ObservationT[]>([]);
  const [mapping, setMapping] = useState<ObservationMappingInboxResponseT['items']>([]);
  const [concepts, setConcepts] = useState<MedicalConceptT[]>([]);
  const [suggestions, setSuggestions] = useState<ObservationSuggestionT[]>([]);
  const [suggestionSelections, setSuggestionSelections] = useState<Record<string, Record<string, boolean>>>({});
  const [suggestionOverrides, setSuggestionOverrides] = useState<Record<string, Record<string, { value_raw: string; unit_raw: string }>>>({});
  const [mappingSelection, setMappingSelection] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workbench, setWorkbench] = useState(false);
  const [editing, setEditing] = useState<ObservationT | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [conflict, setConflict] = useState<ObservationT | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [facts, inbox, catalog, suggestionResult] = await Promise.all([
        api.observations(person.id, detail ? { document_id: detail.id, limit: 100 } : { limit: 100 }),
        api.observationMappingInbox(person.id),
        api.medicalConcepts('', undefined, 100),
        detail ? api.observationSuggestions(detail.id) : Promise.resolve({ suggestions: [] }),
      ]);
      setObservations(facts.observations);
      setMapping(inbox.items);
      setConcepts(catalog.concepts.filter((item) => item.kind !== 'derived'));
      setSuggestions(suggestionResult.suggestions);
      setSuggestionSelections((current) => {
        const next = { ...current };
        for (const suggestion of suggestionResult.suggestions) {
          next[suggestion.id] ??= Object.fromEntries(suggestion.payload.rows.map((row) => [
            row.row_id, !suggestion.accepted_row_ids.includes(row.row_id),
          ]));
        }
        return next;
      });
      setSuggestionOverrides((current) => {
        const next = { ...current };
        for (const suggestion of suggestionResult.suggestions) {
          next[suggestion.id] ??= Object.fromEntries(suggestion.payload.rows.map((row) => [
            row.row_id, { value_raw: row.draft.value_raw, unit_raw: row.draft.unit_raw ?? '' },
          ]));
        }
        return next;
      });
      setMappingSelection((current) => {
        const next = { ...current };
        for (const item of inbox.items) {
          if (next[item.input_fingerprint]) continue;
          const key = item.local_name.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
          next[item.input_fingerprint] = catalog.concepts.find((concept) => (
            concept.display_name.normalize('NFKC').trim().toLocaleLowerCase('zh-CN') === key
            || concept.aliases.some((alias) => alias.normalize('NFKC').trim().toLocaleLowerCase('zh-CN') === key)
          ))?.code ?? '';
        }
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '指标数据加载失败');
    } finally { setLoading(false); }
  }, [person.id, detail?.id]);

  useEffect(() => { void load(); }, [load]);

  const activeMapping = useMemo(() => detail
    ? mapping.filter((item) => observations.some((value) => item.observation_ids.includes(value.id)))
    : mapping, [detail, mapping, observations]);

  const resolve = async (item: ObservationMappingInboxResponseT['items'][number]) => {
    const code = mappingSelection[item.input_fingerprint];
    const concept = concepts.find((entry) => entry.code === code);
    const rows = observations.filter((value) => item.observation_ids.includes(value.id));
    if (!concept) { setError('请先选择要映射的标准指标'); return; }
    if (rows.length === 0) { setError('待映射事实不在当前列表，请刷新后重试'); return; }
    setBusy(item.input_fingerprint); setError(null);
    try {
      await api.resolveObservationMapping(person.id, {
        client_operation_id: uuidv7(), mode: 'selected',
        input_fingerprint: item.input_fingerprint, local_name: item.local_name,
        context: item.context, concept_code: concept.code,
        catalog_version: concept.catalog_version,
        rows: rows.map((value) => ({ observation_id: value.id, if_revision: value.revision })),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof ApiFailure && cause.code === 'revision_conflict'
        ? '部分待映射事实已在其他设备更新，请刷新后重新确认。'
        : cause instanceof Error ? cause.message : '指标映射失败');
    } finally { setBusy(null); }
  };

  const openEdit = (value: ObservationT) => {
    setEditing(value); setDraft(editDraft(value)); setConflict(null); setError(null);
  };

  const acceptSuggestion = async (suggestion: ObservationSuggestionT) => {
    if (!detail) return;
    const selected = suggestion.payload.rows.filter((row) => (
      suggestionSelections[suggestion.id]?.[row.row_id]
      && !suggestion.accepted_row_ids.includes(row.row_id)
    ));
    if (selected.length === 0) { setError('请至少选择一行建议'); return; }
    setBusy(suggestion.id); setError(null);
    try {
      await api.acceptObservationSuggestion(detail.id, suggestion.id, {
        client_operation_id: uuidv7(), if_input_revision: suggestion.input_revision,
        rows: selected.map((row) => {
          const override = suggestionOverrides[suggestion.id]?.[row.row_id];
          const overrides: { value_raw?: string; unit_raw?: string | null } = {};
          if (override?.value_raw !== row.draft.value_raw) overrides.value_raw = override?.value_raw;
          if ((override?.unit_raw ?? '') !== (row.draft.unit_raw ?? '')) overrides.unit_raw = override?.unit_raw || null;
          return { suggestion_row_id: row.row_id, client_row_id: uuidv7(), overrides };
        }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '指标建议接受失败');
    } finally { setBusy(null); }
  };

  const saveEdit = async () => {
    if (!editing || !draft || !draft.correction_note.trim()) return;
    setBusy(editing.id); setError(null);
    try {
      const body = ObservationPatchRequest.parse({
        client_operation_id: uuidv7(), if_revision: editing.revision,
        correction_note: draft.correction_note,
        value_raw: draft.value_raw, unit_raw: draft.unit_raw || null,
        ref_low: numberOrNull(draft.ref_low), ref_high: numberOrNull(draft.ref_high),
        ref_text: draft.ref_text || null,
      });
      await api.patchObservation(editing.id, body);
      setEditing(null); setDraft(null); setConflict(null); await load();
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.code === 'revision_conflict') {
        const current = cause.details?.current;
        if (current && typeof current === 'object') setConflict(current as ObservationT);
      }
      setError(cause instanceof Error ? cause.message : '指标修正失败');
    } finally { setBusy(null); }
  };

  const archive = async (value: ObservationT) => {
    const note = window.prompt('请填写归档原因', '重复或误录');
    if (!note?.trim()) return;
    setBusy(value.id); setError(null);
    try {
      await api.archiveObservation(value.id, {
        client_operation_id: uuidv7(), if_revision: value.revision, correction_note: note.trim(),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '指标归档失败');
    } finally { setBusy(null); }
  };

  return (
    <Card className="space-y-4" data-testid="observation-panel">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-ink"><Activity size={18} className="text-brand-600" />已入库指标</h2>
          <p className="text-xs text-muted">每一行都标注了它凭什么可信：<strong>机器校验</strong>＝被化验单自身的算术等式验算通过；<strong>未经验证</strong>＝单据上没有可交叉验算的冗余；<strong>校验未通过</strong>＝等式没算平，很可能读错了。发现不对用行内的「修正」。</p>
        </div>
        <div className="flex items-center gap-2">
          {activeMapping.length > 0 && <Badge variant="warning">{activeMapping.length} 项待映射</Badge>}
          <Button variant="primary" size="sm" iconLeft={<Plus size={14} />} onClick={() => setWorkbench(true)} data-testid="open-observation-workbench">
            {detail ? '从原件录入' : '录入指标'}
          </Button>
        </div>
      </div>

      {error && <Alert variant="danger"><AlertTriangle size={16} /><span>{error}</span></Alert>}
      {loading ? (
        <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted"><LoaderCircle className="animate-spin" size={17} />正在加载指标…</div>
      ) : observations.length === 0 ? (
        <EmptyState variant="inline" icon={<Activity />} title="还没有已入库指标" description="可以手工录入；智能识别不是必需步骤。" />
      ) : (
        <div className={compact ? 'max-h-80 overflow-y-auto' : ''}>
          <div className="divide-y divide-line rounded-xl border border-line bg-white">
            {observations.map((value) => (
              <div key={value.id} className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(8rem,.7fr)_minmax(8rem,.8fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="truncate text-sm text-ink">{value.local_name}</strong>
                    {value.concept_code ? <Badge variant="success">{value.concept_code}</Badge> : <Badge variant="warning">待映射</Badge>}
                    {value.is_derived && <Badge variant="info" icon={<WandSparkles size={12} />}>确定性派生</Badge>}
                    {/* review_status 是唯一诚实区分「人看过」与「机器算过」的地方(ADR-053)。
                        不标出来,用户就无从判断眼前这个数字有没有被人核对过。 */}
                    {VERIFICATION_BADGE[value.review_status] && (
                      <Badge
                        variant={VERIFICATION_BADGE[value.review_status]!.variant}
                        icon={VERIFICATION_BADGE[value.review_status]!.icon}
                      >
                        {VERIFICATION_BADGE[value.review_status]!.label}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted">{value.observed_on}{value.time_precision === 'date' ? ' · 仅日期' : ''} · {value.specimen_label || value.specimen || '标本未记录'}</p>
                </div>
                <div>
                  <strong className="text-base text-ink">{valueLabel(value)}</strong>
                  {(value.ref_text || value.ref_low !== null || value.ref_high !== null) && <p className="text-xs text-muted">参考 {value.ref_text || `${value.ref_low ?? ''}–${value.ref_high ?? ''}`}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={abnormalVariant(value)}>{value.abnormal_flag_raw || value.abnormal_flag || '未标记'}</Badge>
                  {value.source_page?.source_available ? (
                    <Button variant="ghost" size="sm" iconLeft={<ExternalLink size={13} />} onClick={() => {
                      if (value.source_page?.current_document_id && value.source_page.current_page_no) onOpenSource?.(value.source_page.current_document_id, value.source_page.current_page_no);
                    }}>来源第 {value.source_page.current_page_no} 页</Button>
                  ) : value.source_page ? <Badge variant="warning">来源原件不可用</Badge> : <Badge variant="neutral">无来源页</Badge>}
                </div>
                <div className="flex justify-end gap-1">
                  {!value.is_derived && <Button variant="ghost" size="sm" iconLeft={<Edit3 size={13} />} disabled={busy === value.id} onClick={() => openEdit(value)}>修正</Button>}
                  {!value.is_derived && <Button variant="ghost" size="sm" iconLeft={<Archive size={13} />} disabled={busy === value.id} onClick={() => void archive(value)}>归档</Button>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeMapping.length > 0 && (
        <div className="space-y-3 rounded-2xl border border-warning-border bg-warning-bg/60 p-4" data-testid="observation-mapping-inbox">
          <div><h3 className="flex items-center gap-2 text-sm font-bold text-ink"><Link2 size={16} />待整理指标名称</h3><p className="text-xs text-muted">人工选择本地标准目录；确认后同名新记录会自动应用这条个人 alias。</p></div>
          {activeMapping.map((item) => (
            <div key={item.input_fingerprint} className="grid gap-2 rounded-xl border border-warning-border bg-white p-3 md:grid-cols-[minmax(10rem,1fr)_minmax(14rem,1.5fr)_auto] md:items-center">
              <div><strong className="text-sm text-ink">{item.local_name}</strong><p className="text-xs text-muted">{item.count} 条 · {item.first_observed_on}–{item.latest_observed_on}</p></div>
              <Select value={mappingSelection[item.input_fingerprint] ?? ''} onChange={(event) => setMappingSelection((current) => ({ ...current, [item.input_fingerprint]: event.target.value }))} aria-label={`${item.local_name} 标准指标`}>
                <option value="">搜索/选择标准指标</option>
                {concepts.map((concept) => <option key={concept.code} value={concept.code}>{concept.display_name} · {concept.code}</option>)}
              </Select>
              <Button variant="primary" size="sm" iconLeft={<Search size={13} />} loading={busy === item.input_fingerprint} onClick={() => void resolve(item)}>确认映射</Button>
            </div>
          ))}
        </div>
      )}

      {/* 建议接受区块已移除(ADR-054)。提取行现在全部入库并各自带可信度,
          不再要求用户对着看不懂的数字点"接受" —— 那次点击既不产生验证,
          又会把值记成"已由某某确认"。发现某行不对时用行内的「修正」即可。 */}

      {workbench && <ObservationWorkbench person={person} detail={detail} encounters={encounters} onClose={() => setWorkbench(false)} onSaved={() => void load()} />}

      {editing && draft && (
        <Dialog open onClose={() => { setEditing(null); setDraft(null); setConflict(null); }} size="lg" title={`修正 · ${editing.local_name}`} description="必须填写修正原因；原值、修订前后和 operation 会进入可恢复审计。">
          <div className="space-y-4">
            {conflict && (
              <Alert variant="warning"><span>远端 revision 已更新为 {conflict.revision}。可采用远端值，再基于最新版本重试。</span><Button size="sm" variant="outline" onClick={() => { setEditing(conflict); setDraft(editDraft(conflict)); setConflict(null); }}>采用远端后继续</Button></Alert>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="原始结果" required><Input value={draft.value_raw} onChange={(event) => setDraft({ ...draft, value_raw: event.target.value })} /></Field>
              <Field label="单位"><Input value={draft.unit_raw} onChange={(event) => setDraft({ ...draft, unit_raw: event.target.value })} /></Field>
              <Field label="参考下限"><Input inputMode="decimal" value={draft.ref_low} onChange={(event) => setDraft({ ...draft, ref_low: event.target.value })} /></Field>
              <Field label="参考上限"><Input inputMode="decimal" value={draft.ref_high} onChange={(event) => setDraft({ ...draft, ref_high: event.target.value })} /></Field>
              <Field label="参考原文" className="sm:col-span-2"><Input value={draft.ref_text} onChange={(event) => setDraft({ ...draft, ref_text: event.target.value })} /></Field>
              <Field label="修正原因" required className="sm:col-span-2"><Input value={draft.correction_note} onChange={(event) => setDraft({ ...draft, correction_note: event.target.value })} placeholder="例如：重新核对原件后修正小数点" /></Field>
            </div>
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => { setEditing(null); setDraft(null); }}>取消</Button><Button variant="primary" iconLeft={<Save size={14} />} loading={busy === editing.id} disabled={!draft.value_raw.trim() || !draft.correction_note.trim()} onClick={() => void saveEdit()}>保存修正</Button></div>
          </div>
        </Dialog>
      )}
    </Card>
  );
}
