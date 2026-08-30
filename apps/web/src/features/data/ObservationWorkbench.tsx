import { useEffect, useMemo, useState } from 'react';
import {
  ObservationBatchCreateRequest,
  type DocumentDetailResponseT, type EncounterT, type MedicalConceptListResponseT,
} from '@amr/contracts';
import {
  AlertTriangle, CheckCircle2, ClipboardPaste, Copy, FileSpreadsheet, LoaderCircle,
  Plus, Save, Trash2,
} from 'lucide-react';
import { uuidv7 } from 'uuidv7';
import type { Person } from '../../App.js';
import { api, ApiFailure } from '../../api/client.js';
import {
  deleteObservationDraft, getObservationDraft, putObservationDraft,
  type ObservationDraftRecord, type ObservationDraftRow,
} from '../../offline/db.js';
import { Alert } from '../../ui/Alert.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Dialog } from '../../ui/Dialog.js';
import { Field } from '../../ui/Field.js';
import { Input } from '../../ui/Input.js';
import { Select } from '../../ui/Select.js';
import { cn } from '../../ui/cn.js';

type Concept = MedicalConceptListResponseT['concepts'][number];

function emptyRow(pageNo: number | null = null): ObservationDraftRow {
  return {
    client_row_id: uuidv7(), local_name: '', concept_code: null, concept_catalog_version: null,
    value_raw: '', unit_raw: '', ref_low: '', ref_high: '', ref_text: '',
    abnormal_flag_raw: '', source_page_no: pageNo,
  };
}

function draftKey(personId: string, documentId: string | null): string {
  return `observation:${personId}:${documentId ?? 'standalone'}`;
}

function initialDraft(
  person: Pick<Person, 'id' | 'display_name'>,
  detail: DocumentDetailResponseT | null,
  encounters: EncounterT[],
): ObservationDraftRecord {
  const sampled = detail?.effective_metadata.sampled_on.value ?? null;
  const reported = detail?.effective_metadata.reported_on.value ?? null;
  const now = new Date().toISOString();
  return {
    draft_key: draftKey(person.id, detail?.id ?? null), person_id: person.id,
    document_id: detail?.id ?? null,
    document_title: detail?.effective_metadata.title.value ?? detail?.original_filename ?? null,
    client_operation_id: uuidv7(),
    defaults: {
      encounter_id: detail?.encounters[0]?.id ?? encounters[0]?.id ?? null,
      observed_on: sampled ?? reported ?? detail?.capture_date ?? new Date().toISOString().slice(0, 10),
      time_precision: 'date', observed_at: null,
      date_source: sampled ? 'document_sampled' : reported ? 'document_reported' : 'manual',
      specimen: '', method: '', device: '',
    },
    rows: [emptyRow(detail?.pages[0]?.page_no ?? null)], created_at: now, updated_at: now,
  };
}

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function findConcept(value: string, concepts: Concept[]): Concept | null {
  const key = normalized(value);
  return concepts.find((item) => normalized(item.display_name) === key
    || normalized(item.code) === key
    || item.aliases.some((alias) => normalized(alias) === key)) ?? null;
}

function parseNumber(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : null;
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(current.trim()); current = '';
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

const HEADER_KEYS: Record<string, keyof ObservationDraftRow> = {
  项目: 'local_name', 指标: 'local_name', 名称: 'local_name', item: 'local_name', test: 'local_name',
  结果: 'value_raw', 数值: 'value_raw', result: 'value_raw', value: 'value_raw',
  单位: 'unit_raw', unit: 'unit_raw',
  参考下限: 'ref_low', 下限: 'ref_low', low: 'ref_low',
  参考上限: 'ref_high', 上限: 'ref_high', high: 'ref_high',
  参考范围: 'ref_text', 参考值: 'ref_text', reference: 'ref_text',
  标记: 'abnormal_flag_raw', 异常: 'abnormal_flag_raw', flag: 'abnormal_flag_raw',
};

export function parseObservationPaste(text: string, pageNo: number | null): ObservationDraftRow[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const delimiter = lines.some((line) => line.includes('\t')) ? '\t' : ',';
  const cells = lines.map((line) => splitDelimitedLine(line, delimiter));
  const header = cells[0]!.map((cell) => HEADER_KEYS[normalized(cell)] ?? null);
  const hasHeader = header.some(Boolean);
  const positions: Array<keyof ObservationDraftRow> = [
    'local_name', 'value_raw', 'unit_raw', 'ref_low', 'ref_high', 'abnormal_flag_raw',
  ];
  return cells.slice(hasHeader ? 1 : 0).map((values) => {
    const row = emptyRow(pageNo);
    values.forEach((value, index) => {
      const key = hasHeader ? header[index] : positions[index];
      if (key && typeof row[key] === 'string') (row[key] as string) = value;
    });
    if (!row.ref_high && !row.ref_low && row.ref_text) {
      const match = row.ref_text.match(/^\s*(-?\d+(?:\.\d+)?)\s*[-–—~至]\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (match) { row.ref_low = match[1]!; row.ref_high = match[2]!; }
    }
    return row;
  }).filter((row) => row.local_name || row.value_raw);
}

export function ObservationWorkbench({
  person, detail, encounters, onClose, onSaved,
}: {
  person: Pick<Person, 'id' | 'display_name'>;
  detail: DocumentDetailResponseT | null;
  encounters: EncounterT[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const key = draftKey(person.id, detail?.id ?? null);
  const [draft, setDraft] = useState<ObservationDraftRecord | null>(null);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [pasteText, setPasteText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [previewPage, setPreviewPage] = useState(detail?.pages[0]?.page_no ?? 1);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getObservationDraft(key), api.medicalConcepts('', undefined, 100)])
      .then(([saved, catalog]) => {
        if (cancelled) return;
        setDraft(saved ?? initialDraft(person, detail, encounters));
        setConcepts(catalog.concepts);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '工作台加载失败');
      });
    return () => { cancelled = true; };
  }, [key]);

  useEffect(() => {
    if (!draft || saving) return;
    const timer = window.setTimeout(() => {
      void putObservationDraft({ ...draft, updated_at: new Date().toISOString() });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft, saving]);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (!draft?.rows.some((row) => row.local_name || row.value_raw)) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [draft]);

  const conceptByCode = useMemo(() => new Map(concepts.map((item) => [item.code, item])), [concepts]);
  const sourcePreview = detail?.pages.find((item) => item.page_no === previewPage)
    ?? detail?.pages[0] ?? null;

  const updateRow = (index: number, patch: Partial<ObservationDraftRow>) => {
    setDraft((current) => current ? {
      ...current, rows: current.rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row),
    } : current);
    setRowErrors((current) => {
      if (!draft?.rows[index]) return current;
      const next = { ...current }; delete next[draft.rows[index]!.client_row_id]; return next;
    });
  };

  const setConcept = (index: number, input: string) => {
    const concept = findConcept(input, concepts);
    updateRow(index, {
      local_name: input,
      concept_code: concept?.code ?? null,
      concept_catalog_version: concept?.catalog_version ?? null,
      unit_raw: draft?.rows[index]?.unit_raw || concept?.canonical_unit || '',
    });
  };

  const addRow = (base?: ObservationDraftRow) => {
    setDraft((current) => current ? {
      ...current,
      rows: [...current.rows, base ? {
        ...base, client_row_id: uuidv7(), value_raw: '', abnormal_flag_raw: '',
      } : emptyRow(detail?.pages[0]?.page_no ?? null)],
    } : current);
  };

  const removeRow = (index: number) => {
    setDraft((current) => current ? {
      ...current,
      rows: current.rows.length === 1
        ? [emptyRow(detail?.pages[0]?.page_no ?? null)]
        : current.rows.filter((_, rowIndex) => rowIndex !== index),
    } : current);
  };

  const importPaste = () => {
    const rows = parseObservationPaste(pasteText, detail?.pages[0]?.page_no ?? null).map((row) => {
      const concept = findConcept(row.local_name, concepts);
      return {
        ...row, concept_code: concept?.code ?? null,
        concept_catalog_version: concept?.catalog_version ?? null,
        unit_raw: row.unit_raw || concept?.canonical_unit || '',
      };
    });
    if (rows.length === 0) { setError('没有识别到可导入的行'); return; }
    setDraft((current) => current ? {
      ...current,
      rows: [...(current.rows.length === 1 && !current.rows[0]!.local_name && !current.rows[0]!.value_raw
        ? [] : current.rows), ...rows],
    } : current);
    setPasteText(''); setShowPaste(false); setError(null);
  };

  const closeSafely = () => {
    const hasInput = draft?.rows.some((row) => row.local_name || row.value_raw);
    if (hasInput && !window.confirm('草稿已经保存在本机。确认暂时离开录入工作台？')) return;
    onClose();
  };

  const discardDraft = async () => {
    if (!window.confirm('确认删除本机上的这份指标草稿？尚未提交的内容无法恢复。')) return;
    await deleteObservationDraft(key);
    onClose();
  };

  const save = async () => {
    if (!draft) return;
    const invalid: Record<string, string> = {};
    for (const row of draft.rows) {
      if (!row.local_name.trim()) invalid[row.client_row_id] = '请填写指标名称';
      else if (!row.value_raw.trim()) invalid[row.client_row_id] = '请填写原始结果';
    }
    if (!draft.defaults.observed_on) {
      setError('请填写报告级观察日期'); return;
    }
    if (Object.keys(invalid).length > 0) {
      setRowErrors(invalid); setError(`有 ${Object.keys(invalid).length} 行尚未填写完整`); return;
    }

    setSaving(true); setError(null); setWarnings([]); setRowErrors({});
    let current = draft;
    const total = current.rows.length;
    let done = 0;
    setProgress({ done, total });
    try {
      while (current.rows.length > 0) {
        const chunk = current.rows.slice(0, 100);
        const body = ObservationBatchCreateRequest.parse({
          client_operation_id: current.client_operation_id,
          defaults: {
            document_id: current.document_id,
            encounter_id: current.defaults.encounter_id,
            observed_on: current.defaults.observed_on,
            observed_at: current.defaults.time_precision === 'minute' ? current.defaults.observed_at : null,
            time_precision: current.defaults.time_precision,
            date_source: current.defaults.date_source,
            specimen: current.defaults.specimen || null,
            specimen_label: current.defaults.specimen || null,
            method: current.defaults.method || null,
            device: current.defaults.device || null,
          },
          observations: chunk.map((row) => {
            const page = detail?.pages.find((item) => item.page_no === row.source_page_no);
            return {
              client_row_id: row.client_row_id, local_name: row.local_name,
              concept_code: row.concept_code,
              concept_catalog_version: row.concept_catalog_version,
              value_raw: row.value_raw, unit_raw: row.unit_raw || null,
              ref_low: parseNumber(row.ref_low), ref_high: parseNumber(row.ref_high),
              ref_text: row.ref_text || null, abnormal_flag_raw: row.abnormal_flag_raw || null,
              result_kind: 'measured',
              source_page: page ? {
                origin_capture_document_id: page.origin_capture_document_id,
                origin_capture_order: page.origin_capture_order,
                object_sha256: page.origin_object_sha256,
                logical_page_index: 1, bbox: null,
              } : null,
            };
          }),
        });
        // operation ID 先落本机；网络响应丢失时可安全重试完全相同的首块。
        await putObservationDraft(current);
        const response = await api.createObservations(person.id, body);
        setWarnings((existing) => [...existing, ...response.warnings.map((warning) => warning.message)]);
        done += chunk.length;
        current = {
          ...current, rows: current.rows.slice(chunk.length), client_operation_id: uuidv7(),
          updated_at: new Date().toISOString(),
        };
        setDraft(current); setProgress({ done, total });
        if (current.rows.length > 0) await putObservationDraft(current);
      }
      await deleteObservationDraft(key);
      onSaved(); onClose();
    } catch (cause) {
      if (cause instanceof ApiFailure) {
        const issues = Array.isArray(cause.details?.issues) ? cause.details.issues : [];
        const errors: Record<string, string> = {};
        for (const issue of issues as Array<{ path?: Array<string | number>; message?: string }>) {
          const rowIndex = issue.path?.[0] === 'observations' && typeof issue.path[1] === 'number'
            ? issue.path[1] : null;
          if (rowIndex !== null && current.rows[rowIndex]) {
            errors[current.rows[rowIndex]!.client_row_id] = issue.message ?? cause.message;
          }
        }
        setRowErrors(errors);
        setError(cause.code === 'revision_conflict'
          ? '远端数据已变化；草稿已保留，请重新加载来源后逐字段核对。'
          : cause.message);
      } else setError(cause instanceof Error ? cause.message : '指标保存失败');
    } finally {
      setSaving(false); setProgress(null);
    }
  };

  return (
    <Dialog
      open onClose={closeSafely} size="full" className="max-w-[96rem]"
      closeOnBackdropClick={false} closeOnEsc={false}
      title={detail ? `录入 · ${detail.effective_metadata.title.value ?? detail.original_filename ?? detail.short_id}` : `录入 · ${person.display_name}`}
      description="原值优先保存；未映射项目和未知单位可以提交，但不会被悄悄纳入趋势。草稿自动保存在本机。"
    >
      {!draft ? (
        <div className="flex min-h-72 items-center justify-center gap-2 text-muted"><LoaderCircle className="animate-spin" />正在恢复草稿…</div>
      ) : (
        <div className="space-y-4" data-testid="observation-workbench">
          {error && <Alert variant="danger"><AlertTriangle size={16} /><span>{error}</span></Alert>}
          {warnings.length > 0 && (
            <Alert variant="warning"><span>{[...new Set(warnings)].join('；')}</span></Alert>
          )}

          <div className={detail ? 'grid min-w-0 gap-4 xl:grid-cols-[minmax(20rem,.62fr)_minmax(0,1.38fr)]' : ''}>
            {detail && (
              <aside className="min-w-0 space-y-3 xl:sticky xl:top-0 xl:self-start">
                <div className="overflow-hidden rounded-2xl border border-line bg-slate-950">
                  <div className="flex min-h-[24rem] items-center justify-center p-2">
                    {sourcePreview?.preview_kind === 'pdf_browser' ? (
                      <iframe title="录入来源 PDF" src={sourcePreview.original_url} className="h-[58vh] min-h-[28rem] w-full rounded-lg bg-white" />
                    ) : sourcePreview ? (
                      <img src={sourcePreview.original_url} alt={`来源第 ${sourcePreview.page_no} 页`} className="max-h-[64vh] max-w-full rounded-lg object-contain" />
                    ) : <span className="text-sm text-white/70">来源原件不可用</span>}
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-white/10 bg-white p-3">
                    <span className="text-xs text-muted">录入时逐行绑定稳定来源页</span>
                    <Select value={previewPage} onChange={(event) => setPreviewPage(Number(event.target.value))} className="max-w-32" aria-label="原件预览页">
                      {detail.pages.map((item) => <option key={item.page_no} value={item.page_no}>第 {item.page_no} 页</option>)}
                    </Select>
                  </div>
                </div>
              </aside>
            )}
            <div className="min-w-0 space-y-4">

          <div className="grid gap-3 rounded-2xl border border-line bg-surface-subtle/70 p-4 md:grid-cols-3 xl:grid-cols-7">
            <Field label="观察日期" required>
              <Input type="date" value={draft.defaults.observed_on} onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, observed_on: event.target.value } })} />
            </Field>
            <Field label="日期来源">
              <Select value={draft.defaults.date_source} onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, date_source: event.target.value as ObservationDraftRecord['defaults']['date_source'] } })}>
                <option value="manual">人工填写</option><option value="document_sampled">文档采样日期</option><option value="document_reported">文档报告日期</option>
              </Select>
            </Field>
            <Field label="时间精度">
              <Select value={draft.defaults.time_precision} onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, time_precision: event.target.value as ObservationDraftRecord['defaults']['time_precision'], observed_at: event.target.value === 'minute' ? draft.defaults.observed_at : null } })}>
                <option value="date">仅日期</option><option value="minute">精确到分钟</option><option value="unknown">未知</option>
              </Select>
            </Field>
            {draft.defaults.time_precision === 'minute' && (
              <Field label="观察时间" required>
                <Input type="datetime-local" value={draft.defaults.observed_at?.slice(0, 16) ?? ''} onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, observed_at: event.target.value ? new Date(event.target.value).toISOString() : null } })} />
              </Field>
            )}
            <Field label="标本"><Input value={draft.defaults.specimen} placeholder="如 serum" onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, specimen: event.target.value } })} /></Field>
            <Field label="方法"><Input value={draft.defaults.method} onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, method: event.target.value } })} /></Field>
            <Field label="设备"><Input value={draft.defaults.device} onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, device: event.target.value } })} /></Field>
            <Field label="归入就诊">
              <Select value={draft.defaults.encounter_id ?? ''} onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, encounter_id: event.target.value || null } })}>
                <option value="">不归入就诊</option>
                {encounters.map((item) => <option key={item.id} value={item.id}>{item.occurred_on} · {item.department || item.encounter_type}</option>)}
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" iconLeft={<ClipboardPaste size={14} />} onClick={() => setShowPaste((value) => !value)}>粘贴 TSV/CSV</Button>
              <Button variant="outline" size="sm" iconLeft={<Plus size={14} />} onClick={() => addRow()}>增加一行</Button>
              {detail && <Badge variant="neutral">来源页可逐行选择</Badge>}
            </div>
            <span className="text-xs text-muted">{draft.rows.length} 行 · 超过 100 行自动分批 · Tab 键横向移动</span>
          </div>

          {showPaste && (
            <div className="space-y-3 rounded-2xl border border-brand-200 bg-brand-50/50 p-4">
              <div><strong className="text-sm text-ink">从表格粘贴</strong><p className="text-xs text-muted">支持带表头或按“项目、结果、单位、参考下限、参考上限、标记”的 TSV/CSV。</p></div>
              <textarea value={pasteText} onChange={(event) => setPasteText(event.target.value)} rows={6} className="w-full rounded-xl border border-line bg-white p-3 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20" placeholder={'项目\t结果\t单位\t参考范围\t标记\n肌酐\t88.4\tumol/L\t41-81\t↑'} />
              <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => setShowPaste(false)}>取消</Button><Button variant="primary" size="sm" iconLeft={<FileSpreadsheet size={14} />} onClick={importPaste}>导入表格</Button></div>
            </div>
          )}

          <datalist id="medical-concept-catalog">
            {concepts.filter((item) => item.kind !== 'derived').map((item) => <option key={item.code} value={item.display_name}>{item.code} · {item.canonical_unit}</option>)}
          </datalist>
          <div className="overflow-x-auto rounded-2xl border border-line bg-white">
            <table className="min-w-[76rem] w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-surface-subtle text-left text-xs text-muted">
                <tr><th className="w-12 p-2">#</th><th className="min-w-52 p-2">指标</th><th className="min-w-36 p-2">原始结果</th><th className="min-w-28 p-2">单位</th><th className="min-w-24 p-2">参考下限</th><th className="min-w-24 p-2">参考上限</th><th className="min-w-36 p-2">参考原文</th><th className="min-w-24 p-2">标记</th>{detail && <th className="min-w-28 p-2">来源页</th>}<th className="w-24 p-2">操作</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {draft.rows.map((row, index) => {
                  const mapped = row.concept_code ? conceptByCode.get(row.concept_code) : null;
                  return (
                    <tr key={row.client_row_id} className={cn(rowErrors[row.client_row_id] && 'bg-danger-bg/40')} data-testid={`observation-row-${index}`}>
                      <td className="p-2 align-top text-xs text-muted">{index + 1}</td>
                      <td className="p-2 align-top">
                        <input list="medical-concept-catalog" value={row.local_name} onChange={(event) => setConcept(index, event.target.value)} onBlur={(event) => setConcept(index, event.target.value)} className="min-h-10 w-full rounded-lg border border-line px-2.5 outline-none focus:border-brand-500" aria-label={`第 ${index + 1} 行指标`} />
                        <div className="mt-1">{mapped ? <Badge variant="success">{mapped.code}</Badge> : <Badge variant="warning">待映射</Badge>}</div>
                        {rowErrors[row.client_row_id] && <p className="mt-1 text-xs text-danger-text">{rowErrors[row.client_row_id]}</p>}
                      </td>
                      <td className="p-2 align-top"><input value={row.value_raw} onChange={(event) => updateRow(index, { value_raw: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter' && index === draft.rows.length - 1) addRow(row); }} className="min-h-10 w-full rounded-lg border border-line px-2.5 outline-none focus:border-brand-500" aria-label={`第 ${index + 1} 行结果`} /></td>
                      <td className="p-2 align-top"><input value={row.unit_raw} onChange={(event) => updateRow(index, { unit_raw: event.target.value })} className="min-h-10 w-full rounded-lg border border-line px-2.5 outline-none focus:border-brand-500" aria-label={`第 ${index + 1} 行单位`} /></td>
                      <td className="p-2 align-top"><input inputMode="decimal" value={row.ref_low} onChange={(event) => updateRow(index, { ref_low: event.target.value })} className="min-h-10 w-full rounded-lg border border-line px-2.5 outline-none focus:border-brand-500" aria-label={`第 ${index + 1} 行参考下限`} /></td>
                      <td className="p-2 align-top"><input inputMode="decimal" value={row.ref_high} onChange={(event) => updateRow(index, { ref_high: event.target.value })} className="min-h-10 w-full rounded-lg border border-line px-2.5 outline-none focus:border-brand-500" aria-label={`第 ${index + 1} 行参考上限`} /></td>
                      <td className="p-2 align-top"><input value={row.ref_text} onChange={(event) => updateRow(index, { ref_text: event.target.value })} className="min-h-10 w-full rounded-lg border border-line px-2.5 outline-none focus:border-brand-500" aria-label={`第 ${index + 1} 行参考原文`} /></td>
                      <td className="p-2 align-top"><input value={row.abnormal_flag_raw} onChange={(event) => updateRow(index, { abnormal_flag_raw: event.target.value })} className="min-h-10 w-full rounded-lg border border-line px-2.5 outline-none focus:border-brand-500" aria-label={`第 ${index + 1} 行标记`} /></td>
                      {detail && <td className="p-2 align-top"><Select value={row.source_page_no ?? ''} onChange={(event) => { const pageNo = event.target.value ? Number(event.target.value) : null; updateRow(index, { source_page_no: pageNo }); if (pageNo) setPreviewPage(pageNo); }} aria-label={`第 ${index + 1} 行来源页`}><option value="">未指定</option>{detail.pages.map((item) => <option key={item.page_no} value={item.page_no}>第 {item.page_no} 页</option>)}</Select></td>}
                      <td className="p-2 align-top"><div className="flex gap-1"><Button variant="ghost" size="sm" aria-label="复制上一行" title="复制本行结构" onClick={() => addRow(row)}><Copy size={14} /></Button><Button variant="ghost" size="sm" aria-label="删除行" onClick={() => removeRow(index)}><Trash2 size={14} /></Button></div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
            <Button variant="danger-soft" size="sm" iconLeft={<Trash2 size={14} />} disabled={saving} onClick={() => void discardDraft()}>删除本机草稿</Button>
            <div className="flex items-center justify-end gap-2">
              {progress && <span className="text-xs text-muted">已保存 {progress.done}/{progress.total}</span>}
              <Badge variant="success" icon={<CheckCircle2 size={13} />}>草稿自动保存</Badge>
              <Button variant="ghost" onClick={closeSafely} disabled={saving}>稍后继续</Button>
              <Button variant="primary" iconLeft={<Save size={16} />} loading={saving} onClick={() => void save()} data-testid="save-observations">保存 {draft.rows.length} 行</Button>
            </div>
          </div>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
