import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DocumentDetailResponseT, DocumentListItemT, EncounterT, ManualMetadataFieldT, MetadataSuggestionT,
} from '@amr/contracts';
import {
  Archive, Check, ExternalLink, FileDown, FileText, Image as ImageIcon, LoaderCircle, Maximize2,
  MessageSquarePlus, RotateCcw, Save, ShieldCheck, Sparkles, UserRoundCog,
} from 'lucide-react';
import { uuidv7 } from 'uuidv7';
import type { Person } from '../../App.js';
import { api, ApiFailure } from '../../api/client.js';
import { Alert } from '../../ui/Alert.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Dialog } from '../../ui/Dialog.js';
import { Field } from '../../ui/Field.js';
import { Input } from '../../ui/Input.js';
import { Select } from '../../ui/Select.js';
import { ObservationPanel } from '../data/ObservationPanel.js';
import {
  buildMetadataPatch, initialMetadataForm, selectableSuggestionFields,
  type EditableMetadataField, type MetadataForm,
} from './metadata-form.js';

const FIELD_LABEL: Record<ManualMetadataFieldT, string> = {
  doc_type: '文档类型',
  sampled_on: '采样日期',
  reported_on: '报告日期',
  facility_id: '标准机构',
  facility_name_raw: '机构名称',
  department: '科室',
  title: '标题',
  note: '备注',
};

const DOC_TYPES = [
  ['unknown', '待分类'], ['lab_report', '检验报告'], ['imaging_report', '影像报告'],
  ['discharge_summary', '出院记录'], ['prescription', '处方'], ['visit_note', '门诊记录'],
  ['invoice', '票据'], ['other', '其他医疗文件'],
] as const;

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '（空）';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * 弹窗标题。**绝不回退到 original_filename** —— 手机相机给的是 `image.jpg`,
 * 对人没有任何意义,却是用户点开这份报告后看到的第一行字。
 * 系统其实知道这是什么:S1 已经读出了类型、机构和日期,用它们拼一个人话标题。
 */
function documentTitle(detail: DocumentDetailResponseT | null): string {
  if (!detail) return '文档详情';
  const manual = detail.effective_metadata.title.value;
  if (manual) return manual;
  const parts = [
    DOC_TYPES.find(([code]) => code === (detail.effective_metadata.doc_type.value ?? 'unknown'))?.[1] ?? '文档',
    detail.effective_metadata.facility_name.value,
    detail.effective_metadata.sampled_on.value ?? detail.capture_date,
  ].filter((part): part is string => Boolean(part));
  return parts.join(' · ');
}

export function DocumentDetailDialog({
  documentId,
  person,
  summary,
  onClose,
  onChanged,
  onOpenFullscreen,
  onAcknowledge,
  onReassign,
  onArchive,
  onOpenContext,
  initialPage,
  highlightBbox,
  actionBusy = false,
}: {
  documentId: string | null;
  person: Person;
  summary?: DocumentListItemT | null;
  onClose: () => void;
  onChanged: () => void;
  onOpenFullscreen?: () => void;
  onAcknowledge?: () => void;
  onReassign?: () => void;
  onArchive?: () => void;
  onOpenContext?: (clientDocumentId: string) => void;
  initialPage?: number;
  highlightBbox?: { x: number; y: number; width: number; height: number } | null;
  actionBusy?: boolean;
}): JSX.Element | null {
  const [detail, setDetail] = useState<DocumentDetailResponseT | null>(null);
  const [form, setForm] = useState<MetadataForm | null>(null);
  const [dirty, setDirty] = useState<Set<EditableMetadataField>>(new Set());
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    current: Record<string, unknown>;
    draft: Record<string, unknown>;
  } | null>(null);
  const [selectedSuggestionFields, setSelectedSuggestionFields] = useState<Record<string, ManualMetadataFieldT[]>>({});
  const [encounters, setEncounters] = useState<EncounterT[]>([]);
  const [selectedEncounterId, setSelectedEncounterId] = useState('');

  const load = useCallback(async () => {
    if (!documentId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.documentDetail(documentId);
      const encounterResult = await api.encounters(result.person_id);
      setDetail(result);
      setEncounters(encounterResult.encounters);
      setSelectedEncounterId(result.encounters[0]?.id ?? '');
      setForm(initialMetadataForm(result));
      setDirty(new Set());
      setPage(initialPage && result.pages.some((item) => item.page_no === initialPage) ? initialPage : 1);
      setConflict(null);
      setSelectedSuggestionFields(Object.fromEntries(result.suggestions.map((suggestion) => [
        suggestion.id,
        selectableSuggestionFields(suggestion),
      ])));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '文档详情加载失败');
    } finally {
      setLoading(false);
    }
  }, [documentId, initialPage]);

  useEffect(() => {
    setDetail(null);
    setForm(null);
    if (documentId) void load();
  }, [documentId, load]);

  const currentPage = detail?.pages.find((item) => item.page_no === page) ?? detail?.pages[0] ?? null;
  const activeSuggestions = useMemo(
    () => detail?.suggestions.filter((item) => item.state === 'proposed' || item.state === 'partially_accepted') ?? [],
    [detail],
  );

  const updateField = (field: EditableMetadataField, value: string) => {
    setForm((current) => current ? { ...current, [field]: value } : current);
    setDirty((current) => new Set(current).add(field));
  };

  const saveMetadata = async () => {
    if (!detail || !form || dirty.size === 0) return;
    const body = buildMetadataPatch({
      form, dirty, revision: detail.metadata_revision, operationId: uuidv7(),
    });
    setSaving(true);
    setError(null);
    try {
      await api.patchDocumentMetadata(detail.id, body);
      await load();
      onChanged();
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.code === 'revision_conflict') {
        const current = cause.details?.current;
        const draft = cause.details?.draft;
        if (current && typeof current === 'object' && draft && typeof draft === 'object') {
          setConflict({ current: current as Record<string, unknown>, draft: draft as Record<string, unknown> });
        }
      }
      setError(cause instanceof Error ? cause.message : '人工元数据保存失败');
    } finally {
      setSaving(false);
    }
  };

  const useRemoteField = (field: EditableMetadataField) => {
    if (!conflict) return;
    const value = conflict.current[field];
    setForm((current) => current ? { ...current, [field]: value === null || value === undefined ? '' : String(value) } : current);
    setDirty((current) => {
      const next = new Set(current);
      next.delete(field);
      return next;
    });
  };

  const continueAfterMerge = () => {
    if (!detail || !conflict) return;
    const revision = Number(conflict.current.revision);
    if (!Number.isInteger(revision)) return;
    setDetail({ ...detail, metadata_revision: revision });
    setConflict(null);
    setError(null);
  };

  const acceptSuggestion = async (suggestion: MetadataSuggestionT) => {
    if (!detail) return;
    const fields = selectedSuggestionFields[suggestion.id] ?? [];
    if (fields.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await api.acceptMetadataSuggestion(detail.id, suggestion.id, {
        client_operation_id: uuidv7(),
        if_revision: detail.metadata_revision,
        fields,
        overrides: {},
      });
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '建议接受失败');
    } finally {
      setSaving(false);
    }
  };

  const assignEncounter = async () => {
    if (!detail) return;
    const previous = detail.encounters[0] ?? null;
    if ((previous?.id ?? '') === selectedEncounterId) return;
    setSaving(true);
    setError(null);
    try {
      if (previous) {
        const previousDocuments = await api.documents({
          person_id: detail.person_id, encounter_id: previous.id, date_field: 'best_available', limit: 100,
        });
        await api.setEncounterDocuments(previous.id, {
          client_operation_id: uuidv7(),
          if_revision: previous.revision,
          document_ids: previousDocuments.documents.filter((item) => item.id !== detail.id).map((item) => item.id),
        });
      }
      if (selectedEncounterId) {
        const target = encounters.find((item) => item.id === selectedEncounterId);
        if (!target) throw new Error('所选就诊已不可用，请重新加载');
        const targetDocuments = await api.documents({
          person_id: detail.person_id, encounter_id: target.id, date_field: 'best_available', limit: 100,
        });
        await api.setEncounterDocuments(target.id, {
          client_operation_id: uuidv7(),
          if_revision: target.revision,
          document_ids: [...new Set([...targetDocuments.documents.map((item) => item.id), detail.id])],
        });
      }
      await load();
      onChanged();
    } catch (cause) {
      await load();
      setError(cause instanceof Error ? cause.message : '文档归入就诊失败');
    } finally {
      setSaving(false);
    }
  };

  if (!documentId) return null;

  return (
    <Dialog
      open
      onClose={onClose}
      size="full"
      title={documentTitle(detail)}
      description={detail ? `${detail.short_id} · ${detail.pages.length} 页 · 采集于 ${detail.capture_date}` : '正在读取档案'}
      className="max-w-6xl"
    >
      {loading && !detail && (
        <div className="flex min-h-72 items-center justify-center gap-2 text-muted">
          <LoaderCircle className="animate-spin" size={22} /> 正在加载文档详情…
        </div>
      )}

      {error && <Alert variant={conflict ? 'warning' : 'danger'} className="mb-4"><span>{error}</span></Alert>}

      {detail && summary && (
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2 rounded-xl border border-line bg-surface-subtle/60 p-2">
          {onOpenContext && (
            <Button
              size="sm"
              variant="soft"
              iconLeft={<MessageSquarePlus size={14} />}
              onClick={() => onOpenContext(detail.client_document_id)}
            >
              补录情境
            </Button>
          )}
          {currentPage?.preview_kind === 'image' && onOpenFullscreen && (
            <Button size="sm" variant="outline" iconLeft={<Maximize2 size={14} />} onClick={onOpenFullscreen}>专注查看大图</Button>
          )}
          {summary.person_check === 'mismatch' && !summary.person_check_ack_at && onAcknowledge && (
            <Button size="sm" variant="soft" iconLeft={<ShieldCheck size={14} />} disabled={actionBusy} onClick={onAcknowledge}>确认归属无误</Button>
          )}
          {summary.person_check === 'mismatch' && !summary.person_check_ack_at && onReassign && (
            <Button size="sm" variant="outline" iconLeft={<UserRoundCog size={14} />} disabled={actionBusy} onClick={onReassign}>纠正归属人</Button>
          )}
          {onArchive && (
            <Button size="sm" variant="ghost" iconLeft={<Archive size={14} />} disabled={actionBusy} onClick={onArchive}>
              {summary.archived_at ? '恢复文档' : '归档文档'}
            </Button>
          )}
        </div>
      )}

      {conflict && form && (
        <div className="mb-5 space-y-3 rounded-2xl border border-warning-border bg-warning-bg p-4">
          <div>
            <strong className="text-sm text-warning-text">检测到其他设备上的修改</strong>
            <p className="mt-1 text-xs text-warning-text/80">逐字段选择远端值或保留当前草稿，然后基于最新 revision 重试。</p>
          </div>
          <div className="divide-y divide-warning-border/70 rounded-xl border border-warning-border bg-white/80">
            {[...dirty].map((field) => (
              <div key={field} className="grid gap-2 p-3 text-xs sm:grid-cols-[7rem_1fr_1fr_auto] sm:items-center">
                <strong>{FIELD_LABEL[field]}</strong>
                <span><span className="text-muted">远端：</span>{displayValue(conflict.current[field])}</span>
                <span><span className="text-muted">本地：</span>{displayValue(conflict.draft[field])}</span>
                <Button size="sm" variant="outline" onClick={() => useRemoteField(field)}>采用远端</Button>
              </div>
            ))}
          </div>
          <Button size="sm" variant="primary" onClick={continueAfterMerge}>完成合并并准备重试</Button>
        </div>
      )}

      {detail && form && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,.85fr)]">
          <section className="space-y-3">
            <div className="overflow-hidden rounded-2xl border border-line bg-surface-subtle">
              <div className="flex min-h-[26rem] items-center justify-center bg-slate-950/95 p-3">
                {currentPage?.preview_kind === 'pdf_browser' ? (
                  <iframe
                    title={`${detail.original_filename ?? 'PDF'} 第 ${page} 页`}
                    src={currentPage.original_url}
                    className="h-[62vh] min-h-[28rem] w-full rounded-lg bg-white"
                  />
                ) : currentPage ? (
                  <div className="relative inline-flex max-h-[68vh] max-w-full">
                    <img
                      src={currentPage.original_url}
                      alt={`${detail.effective_metadata.title.value ?? '医疗文档'}第 ${page} 页`}
                      className="block max-h-[68vh] max-w-full rounded-lg object-contain"
                    />
                    {highlightBbox && page === initialPage && (
                      <span
                        data-testid="source-bbox-highlight"
                        aria-label="指标在原件中的位置"
                        className="pointer-events-none absolute rounded border-2 border-amber-400 bg-amber-300/25 shadow-[0_0_0_2px_rgba(0,0,0,.35)]"
                        style={{
                          left: `${highlightBbox.x * 100}%`, top: `${highlightBbox.y * 100}%`,
                          width: `${highlightBbox.width * 100}%`, height: `${highlightBbox.height * 100}%`,
                        }}
                      />
                    )}
                  </div>
                ) : (
                  <span className="text-sm text-white/70">来源原件不可用</span>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-white p-3">
                <div className="flex items-center gap-2">
                  <Badge variant="neutral" icon={currentPage?.preview_kind === 'pdf_browser' ? <FileText /> : <ImageIcon />}>
                    第 {page} / {detail.pages.length} 页
                  </Badge>
                  {detail.pages.length > 1 && (
                    <Select value={page} onChange={(event) => setPage(Number(event.target.value))} className="min-w-28">
                      {detail.pages.map((item) => <option key={item.page_no} value={item.page_no}>第 {item.page_no} 页</option>)}
                    </Select>
                  )}
                </div>
                {currentPage && (
                  <div className="flex gap-2">
                    <a href={currentPage.original_url} target="_blank" rel="noreferrer">
                      <Button size="sm" variant="outline" iconLeft={<ExternalLink size={14} />}>新标签打开</Button>
                    </a>
                    <a href={currentPage.original_url} download={detail.original_filename ?? undefined}>
                      <Button size="sm" variant="outline" iconLeft={<FileDown size={14} />}>下载原件</Button>
                    </a>
                  </div>
                )}
              </div>
            </div>
            <p className="text-xs text-muted">
              {currentPage?.preview_kind === 'pdf_browser'
                ? 'PDF 使用浏览器原件查看；若内嵌预览不可用，请使用“新标签打开”或下载。'
                : '图片显示短时授权原件，可在新标签中缩放查看。'}
            </p>
          </section>

          <section className="space-y-5">
            <div className="space-y-4 rounded-2xl border border-line bg-white p-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="font-bold text-ink">人工元数据</h3>
                  <p className="text-xs text-muted">只有保存或明确接受的字段才进入核心事实。</p>
                </div>
                <Badge variant="neutral">revision {detail.metadata_revision}</Badge>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="文档类型">
                  <Select value={form.doc_type} onChange={(event) => updateField('doc_type', event.target.value)}>
                    {DOC_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </Select>
                </Field>
                <Field label="机构名称">
                  <Input value={form.facility_name_raw} onChange={(event) => updateField('facility_name_raw', event.target.value)} />
                </Field>
                <Field label="采样日期">
                  <Input type="date" value={form.sampled_on} onChange={(event) => updateField('sampled_on', event.target.value)} />
                </Field>
                <Field label="报告日期">
                  <Input type="date" value={form.reported_on} onChange={(event) => updateField('reported_on', event.target.value)} />
                </Field>
                <Field label="科室">
                  <Input value={form.department} onChange={(event) => updateField('department', event.target.value)} />
                </Field>
                <Field label="标题">
                  <Input value={form.title} onChange={(event) => updateField('title', event.target.value)} />
                </Field>
              </div>
              <Field label="备注" htmlFor="document-metadata-note">
                <textarea
                  id="document-metadata-note"
                  value={form.note}
                  onChange={(event) => updateField('note', event.target.value)}
                  rows={4}
                  className="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm text-ink shadow-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
                />
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" iconLeft={<RotateCcw size={14} />} disabled={dirty.size === 0} onClick={() => {
                  setForm(initialMetadataForm(detail));
                  setDirty(new Set());
                }}>放弃草稿</Button>
                <Button variant="primary" size="sm" iconLeft={<Save size={14} />} loading={saving} disabled={dirty.size === 0 || !!conflict} onClick={() => void saveMetadata()}>
                  保存人工信息
                </Button>
              </div>
            </div>

            <div className="space-y-3 rounded-2xl border border-line bg-white p-4">
              <div>
                <h3 className="font-bold text-ink">归入就诊</h3>
                <p className="text-xs text-muted">按人 → 就诊 → 文档组织；不会根据智能建议自动归组。</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select value={selectedEncounterId} onChange={(event) => setSelectedEncounterId(event.target.value)}>
                  <option value="">未归入就诊</option>
                  {encounters.map((item) => (
                    <option key={item.id} value={item.id}>{item.occurred_on} · {item.department || item.encounter_type}</option>
                  ))}
                </Select>
                <Button
                  variant="outline"
                  loading={saving}
                  disabled={(detail.encounters[0]?.id ?? '') === selectedEncounterId}
                  onClick={() => void assignEncounter()}
                >
                  保存归组
                </Button>
              </div>
              {encounters.length === 0 && <p className="text-xs text-muted">请先在“数据”页建立一次就诊。</p>}
            </div>

            <ObservationPanel person={person} encounters={encounters} detail={detail} compact />

            <div className="space-y-3 rounded-2xl border border-line bg-surface-subtle/70 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="flex items-center gap-2 font-bold text-ink"><Sparkles size={16} /> 历史建议</h3>
                  <p className="text-xs text-muted">建议可逐字段确认；未确认内容不会进入检索、趋势或导出。</p>
                </div>
                <Badge variant={activeSuggestions.length ? 'warning' : 'neutral'}>{activeSuggestions.length} 条待处理</Badge>
              </div>
              {activeSuggestions.length === 0 ? (
                <p className="rounded-xl border border-line bg-white p-3 text-xs text-muted">当前没有待处理建议。</p>
              ) : activeSuggestions.map((suggestion) => {
                const fields = selectableSuggestionFields(suggestion);
                const selected = selectedSuggestionFields[suggestion.id] ?? [];
                return (
                  <div key={suggestion.id} className="space-y-3 rounded-xl border border-line bg-white p-3">
                    <div className="space-y-2">
                      {fields.map((field) => {
                        const currentValue = field === 'facility_name_raw'
                          ? detail.effective_metadata.facility_name.value
                          : field === 'facility_id' ? null
                          : detail.effective_metadata[field]?.value;
                        return (
                          <label key={field} className="grid cursor-pointer grid-cols-[auto_6rem_1fr] items-start gap-2 text-xs">
                            <input
                              type="checkbox"
                              className="mt-0.5 accent-brand-600"
                              checked={selected.includes(field)}
                              disabled={suggestion.accepted_fields.includes(field)}
                              onChange={(event) => setSelectedSuggestionFields((current) => ({
                                ...current,
                                [suggestion.id]: event.target.checked
                                  ? [...selected, field]
                                  : selected.filter((item) => item !== field),
                              }))}
                            />
                            <strong>{FIELD_LABEL[field]}</strong>
                            <span>
                              <span className="text-muted">当前 {displayValue(currentValue)} → </span>
                              <span className="text-brand-800">建议 {displayValue(suggestion.values[field as keyof typeof suggestion.values])}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    <div className="flex justify-end">
                      <Button size="sm" variant="soft" iconLeft={<Check size={14} />} loading={saving} disabled={selected.length === 0} onClick={() => void acceptSuggestion(suggestion)}>
                        接受选中字段
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </Dialog>
  );
}
