import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EncounterT, MedicationT, TimelineEventT } from '@amr/contracts';
import {
  CalendarClock, Edit3, FileSearch, LoaderCircle, Pill, Plus, Save, Trash2,
} from 'lucide-react';
import { uuidv7 } from 'uuidv7';
import type { Person } from '../../App.js';
import { api, ApiFailure } from '../../api/client.js';
import type { BrowseSourceTarget } from '../browse/BrowseView.js';
import { Alert } from '../../ui/Alert.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { Dialog } from '../../ui/Dialog.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Field } from '../../ui/Field.js';
import { Input } from '../../ui/Input.js';
import { Select } from '../../ui/Select.js';

const MEDICATION_KIND_LABEL = { prescribed: '处方用药', administered: '已执行用药' } as const;
const EVENT_KIND_LABEL = {
  procedure: '操作/手术', hospitalization: '住院', symptom: '症状', change: '变化', other: '其他',
} as const;

interface MedicationForm {
  kind: 'prescribed' | 'administered';
  encounter_id: string;
  name_raw: string;
  generic_name: string;
  dose_raw: string;
  dose_value: string;
  dose_unit: string;
  concentration_pct: string;
  solute_mass_g: string;
  frequency_raw: string;
  route: string;
  administration_group: string;
  group_volume_ml: string;
  sequence: string;
  administered_at: string;
  started_on: string;
  ended_on: string;
  note: string;
  correction_note: string;
}

interface TimelineForm {
  encounter_id: string;
  kind: 'procedure' | 'hospitalization' | 'symptom' | 'change' | 'other';
  title: string;
  time_precision: 'minute' | 'date' | 'unknown';
  occurred_on: string;
  occurred_at: string;
  note: string;
  correction_note: string;
}

const emptyMedication = (): MedicationForm => ({
  kind: 'prescribed', encounter_id: '', name_raw: '', generic_name: '', dose_raw: '',
  dose_value: '', dose_unit: '', concentration_pct: '', solute_mass_g: '', frequency_raw: '',
  route: '', administration_group: '', group_volume_ml: '', sequence: '', administered_at: '',
  started_on: new Date().toISOString().slice(0, 10), ended_on: '', note: '', correction_note: '',
});

const emptyTimeline = (): TimelineForm => ({
  encounter_id: '', kind: 'other', title: '', time_precision: 'date',
  occurred_on: new Date().toISOString().slice(0, 10), occurred_at: '', note: '', correction_note: '',
});

function medicationForm(value: MedicationT): MedicationForm {
  return {
    kind: value.kind, encounter_id: value.encounter_id ?? '', name_raw: value.name_raw,
    generic_name: value.generic_name ?? '', dose_raw: value.dose_raw ?? '',
    dose_value: value.dose_value?.toString() ?? '', dose_unit: value.dose_unit ?? '',
    concentration_pct: value.concentration_pct?.toString() ?? '',
    solute_mass_g: value.solute_mass_g?.toString() ?? '', frequency_raw: value.frequency_raw ?? '',
    route: value.route ?? '', administration_group: value.administration_group ?? '',
    group_volume_ml: value.group_volume_ml?.toString() ?? '', sequence: value.sequence?.toString() ?? '',
    administered_at: value.administered_at?.slice(0, 16) ?? '', started_on: value.started_on ?? '',
    ended_on: value.ended_on ?? '', note: value.note ?? '', correction_note: '',
  };
}

function timelineForm(value: TimelineEventT): TimelineForm {
  return {
    encounter_id: value.encounter_id ?? '', kind: value.kind, title: value.title,
    time_precision: value.time_precision, occurred_on: value.occurred_on ?? '',
    occurred_at: value.occurred_at?.slice(0, 16) ?? '', note: value.note ?? '', correction_note: '',
  };
}

const nullableText = (value: string) => value.trim() || null;
const nullableNumber = (value: string) => value === '' ? null : Number(value);
const textareaClass = 'w-full rounded-xl border border-line px-3.5 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20';

function sourceTarget(value: MedicationT | TimelineEventT): BrowseSourceTarget | null {
  const page = value.source_page;
  if (!page?.source_available || !page.current_document_id || !page.current_page_no) return null;
  return { documentId: page.current_document_id, pageNo: page.current_page_no, bbox: page.bbox };
}

function formatClinicalTime(value: MedicationT): string {
  if (value.time_precision === 'minute' && value.canonical_at) {
    return new Date(value.canonical_at).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }
  return `${value.canonical_on} · 仅日期`;
}

export function ClinicalFactsPanel({
  person, encounters, onOpenSource,
}: {
  person: Person;
  encounters: EncounterT[];
  onOpenSource?: (target: BrowseSourceTarget) => void;
}): JSX.Element {
  const [medications, setMedications] = useState<MedicationT[]>([]);
  const [events, setEvents] = useState<TimelineEventT[]>([]);
  const [medicationEditing, setMedicationEditing] = useState<MedicationT | 'new' | null>(null);
  const [eventEditing, setEventEditing] = useState<TimelineEventT | 'new' | null>(null);
  const [medicationDraft, setMedicationDraft] = useState<MedicationForm>(emptyMedication);
  const [eventDraft, setEventDraft] = useState<TimelineForm>(emptyTimeline);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [medicationResult, eventResult] = await Promise.all([
        api.medications(person.id), api.timelineEvents(person.id, { include_undated: true }),
      ]);
      setMedications(medicationResult.medications);
      setEvents(eventResult.events);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '用药与事件加载失败');
    } finally {
      setLoading(false);
    }
  }, [person.id]);

  useEffect(() => { void load(); }, [load]);

  const datedEvents = useMemo(() => events.filter((item) => item.time_precision !== 'unknown'), [events]);
  const undatedEvents = useMemo(() => events.filter((item) => item.time_precision === 'unknown'), [events]);

  const openMedication = (value: MedicationT | 'new') => {
    setMedicationEditing(value);
    setMedicationDraft(value === 'new' ? emptyMedication() : medicationForm(value));
    setError(null);
  };

  const openEvent = (value: TimelineEventT | 'new') => {
    setEventEditing(value);
    setEventDraft(value === 'new' ? emptyTimeline() : timelineForm(value));
    setError(null);
  };

  const saveMedication = async () => {
    if (!medicationEditing || !medicationDraft.name_raw.trim()) return;
    const dosePairValid = (medicationDraft.dose_value === '') === (medicationDraft.dose_unit.trim() === '');
    if (!dosePairValid) {
      setError('结构化剂量值与单位必须同时填写；也可以都留空，仅保存剂量原文。');
      return;
    }
    if (medicationDraft.kind === 'prescribed' && !medicationDraft.started_on) {
      setError('处方用药必须填写开始日期。');
      return;
    }
    if (medicationDraft.kind === 'administered' && !medicationDraft.administered_at) {
      setError('已执行用药必须填写执行时间。');
      return;
    }
    setSaving(true);
    setError(null);
    const fact = {
      encounter_id: medicationDraft.encounter_id || null,
      kind: medicationDraft.kind,
      name_raw: medicationDraft.name_raw.trim(),
      generic_name: nullableText(medicationDraft.generic_name),
      dose_raw: nullableText(medicationDraft.dose_raw),
      dose_value: nullableNumber(medicationDraft.dose_value),
      dose_unit: nullableText(medicationDraft.dose_unit),
      concentration_pct: nullableNumber(medicationDraft.concentration_pct),
      solute_mass_g: nullableNumber(medicationDraft.solute_mass_g),
      frequency_raw: nullableText(medicationDraft.frequency_raw),
      route: nullableText(medicationDraft.route),
      administration_group: nullableText(medicationDraft.administration_group),
      group_volume_ml: nullableNumber(medicationDraft.group_volume_ml),
      sequence: medicationDraft.sequence === '' ? null : Number(medicationDraft.sequence),
      administered_at: medicationDraft.kind === 'administered'
        ? new Date(medicationDraft.administered_at).toISOString() : null,
      started_on: medicationDraft.kind === 'prescribed' ? medicationDraft.started_on : null,
      ended_on: medicationDraft.kind === 'prescribed' ? medicationDraft.ended_on || null : null,
      source_page: medicationEditing === 'new' ? null : medicationEditing.source_page
        ? {
            origin_capture_document_id: medicationEditing.source_page.origin_capture_document_id,
            origin_capture_order: medicationEditing.source_page.origin_capture_order,
            object_sha256: medicationEditing.source_page.object_sha256,
            logical_page_index: medicationEditing.source_page.logical_page_index,
            bbox: medicationEditing.source_page.bbox,
          } : null,
      note: nullableText(medicationDraft.note),
    };
    try {
      if (medicationEditing === 'new') {
        await api.createMedications(person.id, {
          client_operation_id: uuidv7(), medications: [{ client_row_id: uuidv7(), ...fact }],
        });
      } else {
        if (!medicationDraft.correction_note.trim()) {
          setError('修改既有用药事实时必须填写修正说明。');
          setSaving(false);
          return;
        }
        await api.patchMedication(medicationEditing.id, {
          client_operation_id: uuidv7(), if_revision: medicationEditing.revision,
          correction_note: medicationDraft.correction_note.trim(), ...fact,
        });
      }
      setMedicationEditing(null);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiFailure && cause.code === 'revision_conflict'
        ? '这条用药事实已在其他设备更新，请重新打开后再修改。'
        : cause instanceof Error ? cause.message : '用药事实保存失败');
    } finally {
      setSaving(false);
    }
  };

  const saveEvent = async () => {
    if (!eventEditing || !eventDraft.title.trim()) return;
    if (eventDraft.time_precision === 'date' && !eventDraft.occurred_on) {
      setError('“仅日期”事件必须填写临床日期。');
      return;
    }
    if (eventDraft.time_precision === 'minute' && !eventDraft.occurred_at) {
      setError('精确时间事件必须填写日期和时刻。');
      return;
    }
    setSaving(true);
    setError(null);
    const occurredAt = eventDraft.time_precision === 'minute'
      ? new Date(eventDraft.occurred_at).toISOString() : null;
    const fact = {
      encounter_id: eventDraft.encounter_id || null,
      kind: eventDraft.kind,
      title: eventDraft.title.trim(),
      occurred_on: eventDraft.time_precision === 'unknown'
        ? null : eventDraft.time_precision === 'minute'
          ? eventDraft.occurred_at.slice(0, 10) : eventDraft.occurred_on,
      occurred_at: occurredAt,
      time_precision: eventDraft.time_precision,
      note: nullableText(eventDraft.note),
      source_page: eventEditing === 'new' ? null : eventEditing.source_page
        ? {
            origin_capture_document_id: eventEditing.source_page.origin_capture_document_id,
            origin_capture_order: eventEditing.source_page.origin_capture_order,
            object_sha256: eventEditing.source_page.object_sha256,
            logical_page_index: eventEditing.source_page.logical_page_index,
            bbox: eventEditing.source_page.bbox,
          } : null,
    };
    try {
      if (eventEditing === 'new') {
        await api.createTimelineEvent(person.id, { client_operation_id: uuidv7(), ...fact });
      } else {
        if (!eventDraft.correction_note.trim()) {
          setError('修改既有事件时必须填写修正说明。');
          setSaving(false);
          return;
        }
        await api.patchTimelineEvent(eventEditing.id, {
          client_operation_id: uuidv7(), if_revision: eventEditing.revision,
          correction_note: eventDraft.correction_note.trim(), ...fact,
        });
      }
      setEventEditing(null);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiFailure && cause.code === 'revision_conflict'
        ? '这条事件已在其他设备更新，请重新打开后再修改。'
        : cause instanceof Error ? cause.message : '事件保存失败');
    } finally {
      setSaving(false);
    }
  };

  const archiveMedication = async (value: MedicationT) => {
    const reason = window.prompt('请填写归档原因。原事实仍保留在审计记录中。');
    if (!reason?.trim()) return;
    setSaving(true);
    try {
      await api.archiveMedication(value.id, {
        client_operation_id: uuidv7(), if_revision: value.revision, correction_note: reason.trim(),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '归档用药失败');
    } finally { setSaving(false); }
  };

  const archiveEvent = async (value: TimelineEventT) => {
    const reason = window.prompt('请填写归档原因。原事实仍保留在审计记录中。');
    if (!reason?.trim()) return;
    setSaving(true);
    try {
      await api.archiveTimelineEvent(value.id, {
        client_operation_id: uuidv7(), if_revision: value.revision, correction_note: reason.trim(),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '归档事件失败');
    } finally { setSaving(false); }
  };

  const SourceButton = ({ value }: { value: MedicationT | TimelineEventT }) => {
    const target = sourceTarget(value);
    if (!value.source_page) return null;
    return target && onOpenSource ? (
      <Button size="sm" variant="ghost" iconLeft={<FileSearch size={14} />} onClick={() => onOpenSource(target)}>
        查看来源
      </Button>
    ) : <Badge variant="neutral">来源原件不可用</Badge>;
  };

  return (
    <section className="space-y-4" data-testid="clinical-facts-panel">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">P4 人工事实</p>
          <h2 className="mt-1 text-xl font-bold text-ink">用药与事件</h2>
          <p className="mt-1 text-sm text-muted">只保存你明确确认的原始事实；不会从备注中推断诊断、疗效或用药建议。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button data-testid="add-medication" variant="soft" iconLeft={<Pill size={16} />} onClick={() => openMedication('new')}>记录用药</Button>
          <Button data-testid="add-timeline-event" variant="soft" iconLeft={<Plus size={16} />} onClick={() => openEvent('new')}>记录事件</Button>
        </div>
      </div>

      {error && <Alert variant="danger"><span>{error}</span></Alert>}
      {loading ? (
        <Card className="flex items-center justify-center gap-2 py-10 text-sm text-muted"><LoaderCircle className="animate-spin" />正在加载用药与事件…</Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="space-y-4" data-testid="medication-list">
            <div className="flex items-center justify-between"><h3 className="font-bold text-ink">用药</h3><Badge variant="neutral">{medications.length} 条</Badge></div>
            {medications.length === 0 ? (
              <EmptyState icon={<Pill />} title="还没有用药事实" description="可以记录处方用药或实际执行的用药。" />
            ) : medications.map((value) => (
              <article key={value.id} className="rounded-xl border border-line bg-surface-subtle/50 p-4" data-testid="medication-item">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2"><Badge variant="brand">{MEDICATION_KIND_LABEL[value.kind]}</Badge><strong className="text-sm text-ink">{value.name_raw}</strong></div>
                    <p className="mt-1 text-xs text-muted">{formatClinicalTime(value)}</p>
                  </div>
                  <div className="flex gap-1"><Button size="sm" variant="ghost" aria-label={`编辑 ${value.name_raw}`} iconLeft={<Edit3 size={14} />} onClick={() => openMedication(value)}>编辑</Button><Button size="sm" variant="ghost" aria-label={`归档 ${value.name_raw}`} iconLeft={<Trash2 size={14} />} disabled={saving} onClick={() => void archiveMedication(value)}>归档</Button></div>
                </div>
                <p className="mt-3 text-sm text-ink-secondary">{[value.dose_raw, value.frequency_raw, value.route].filter(Boolean).join(' · ') || '剂量、频次和途径未记录'}</p>
                {value.administration_group && <p className="mt-1 text-xs text-muted">给药组：{value.administration_group}{value.sequence ? ` · 顺序 ${value.sequence}` : ''}</p>}
                {value.note && <p className="mt-2 text-xs text-muted">备注：{value.note}</p>}
                <div className="mt-2"><SourceButton value={value} /></div>
              </article>
            ))}
          </Card>

          <Card className="space-y-4" data-testid="timeline-list">
            <div className="flex items-center justify-between"><h3 className="font-bold text-ink">人工事件</h3><Badge variant="neutral">{events.length} 条</Badge></div>
            {events.length === 0 ? (
              <EmptyState icon={<CalendarClock />} title="还没有人工事件" description="可记录手术、住院、症状或其他已确认事件。" />
            ) : (
              <>
                <div className="space-y-2">
                  {datedEvents.map((value) => (
                    <article key={value.id} className="rounded-xl border border-line bg-surface-subtle/50 p-4" data-testid="timeline-item">
                      <div className="flex items-start justify-between gap-3">
                        <div><div className="flex flex-wrap items-center gap-2"><Badge variant="brand">{EVENT_KIND_LABEL[value.kind]}</Badge><strong className="text-sm text-ink">{value.title}</strong></div><p className="mt-1 text-xs text-muted">{value.time_precision === 'minute' && value.occurred_at ? new Date(value.occurred_at).toLocaleString('zh-CN') : `${value.occurred_on} · 仅日期`}</p></div>
                        <div className="flex gap-1"><Button size="sm" variant="ghost" aria-label={`编辑 ${value.title}`} iconLeft={<Edit3 size={14} />} onClick={() => openEvent(value)}>编辑</Button><Button size="sm" variant="ghost" aria-label={`归档 ${value.title}`} iconLeft={<Trash2 size={14} />} disabled={saving} onClick={() => void archiveEvent(value)}>归档</Button></div>
                      </div>
                      {value.note && <p className="mt-2 text-xs text-muted">备注：{value.note}</p>}
                      <div className="mt-2"><SourceButton value={value} /></div>
                    </article>
                  ))}
                </div>
                {undatedEvents.length > 0 && (
                  <div className="space-y-2 border-t border-dashed border-line pt-4" data-testid="undated-events">
                    <div><h4 className="text-sm font-bold text-ink">日期未记录</h4><p className="text-xs text-muted">这些事实没有临床日期，不使用创建时间冒充。</p></div>
                    {undatedEvents.map((value) => (
                      <article key={value.id} className="rounded-xl border border-amber-200 bg-amber-50/60 p-4" data-testid="timeline-item-undated">
                        <div className="flex items-start justify-between gap-3"><div><Badge variant="warning">日期未记录</Badge><strong className="ml-2 text-sm text-ink">{value.title}</strong></div><div className="flex gap-1"><Button size="sm" variant="ghost" aria-label={`编辑 ${value.title}`} iconLeft={<Edit3 size={14} />} onClick={() => openEvent(value)}>编辑</Button><Button size="sm" variant="ghost" aria-label={`归档 ${value.title}`} iconLeft={<Trash2 size={14} />} disabled={saving} onClick={() => void archiveEvent(value)}>归档</Button></div></div>
                        {value.note && <p className="mt-2 text-xs text-muted">备注：{value.note}</p>}
                      </article>
                    ))}
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      )}

      <Dialog open={medicationEditing !== null} onClose={() => setMedicationEditing(null)} size="xl" title={medicationEditing === 'new' ? '记录用药事实' : '修正用药事实'} description="处方与实际执行必须区分；保存的是人工确认事实，不生成任何用药建议。">
        <div className="space-y-4" data-testid="medication-dialog">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="事实类型" required><Select data-testid="medication-kind" value={medicationDraft.kind} onChange={(event) => setMedicationDraft({ ...medicationDraft, kind: event.target.value as MedicationForm['kind'] })}><option value="prescribed">处方用药</option><option value="administered">已执行用药</option></Select></Field>
            <Field label="关联就诊"><Select value={medicationDraft.encounter_id} onChange={(event) => setMedicationDraft({ ...medicationDraft, encounter_id: event.target.value })}><option value="">不关联</option>{encounters.map((item) => <option key={item.id} value={item.id}>{item.occurred_on} · {item.department || item.encounter_type}</option>)}</Select></Field>
            <Field label="药名原文" required className="sm:col-span-2"><Input data-testid="medication-name" value={medicationDraft.name_raw} onChange={(event) => setMedicationDraft({ ...medicationDraft, name_raw: event.target.value })} /></Field>
            <Field label="通用名"><Input value={medicationDraft.generic_name} onChange={(event) => setMedicationDraft({ ...medicationDraft, generic_name: event.target.value })} /></Field>
            <Field label="剂量原文"><Input data-testid="medication-dose-raw" value={medicationDraft.dose_raw} onChange={(event) => setMedicationDraft({ ...medicationDraft, dose_raw: event.target.value })} /></Field>
            <Field label="结构化剂量值"><Input type="number" min="0" step="any" value={medicationDraft.dose_value} onChange={(event) => setMedicationDraft({ ...medicationDraft, dose_value: event.target.value })} /></Field>
            <Field label="结构化剂量单位"><Input value={medicationDraft.dose_unit} onChange={(event) => setMedicationDraft({ ...medicationDraft, dose_unit: event.target.value })} /></Field>
            <Field label="浓度 %"><Input type="number" min="0" max="100" step="any" value={medicationDraft.concentration_pct} onChange={(event) => setMedicationDraft({ ...medicationDraft, concentration_pct: event.target.value })} /></Field>
            <Field label="溶质质量 g"><Input type="number" min="0" step="any" value={medicationDraft.solute_mass_g} onChange={(event) => setMedicationDraft({ ...medicationDraft, solute_mass_g: event.target.value })} /></Field>
            <Field label="频次原文"><Input value={medicationDraft.frequency_raw} onChange={(event) => setMedicationDraft({ ...medicationDraft, frequency_raw: event.target.value })} /></Field>
            <Field label="给药途径"><Input value={medicationDraft.route} onChange={(event) => setMedicationDraft({ ...medicationDraft, route: event.target.value })} /></Field>
            <Field label="给药分组"><Input value={medicationDraft.administration_group} onChange={(event) => setMedicationDraft({ ...medicationDraft, administration_group: event.target.value })} /></Field>
            <Field label="分组总体积 mL"><Input type="number" min="0" step="any" value={medicationDraft.group_volume_ml} onChange={(event) => setMedicationDraft({ ...medicationDraft, group_volume_ml: event.target.value })} /></Field>
            <Field label="组内顺序"><Input type="number" min="1" step="1" value={medicationDraft.sequence} onChange={(event) => setMedicationDraft({ ...medicationDraft, sequence: event.target.value })} /></Field>
            {medicationDraft.kind === 'administered' ? <Field label="执行时间" required><Input data-testid="medication-administered-at" type="datetime-local" value={medicationDraft.administered_at} onChange={(event) => setMedicationDraft({ ...medicationDraft, administered_at: event.target.value })} /></Field> : <><Field label="开始日期" required><Input data-testid="medication-started-on" type="date" value={medicationDraft.started_on} onChange={(event) => setMedicationDraft({ ...medicationDraft, started_on: event.target.value })} /></Field><Field label="结束日期"><Input type="date" value={medicationDraft.ended_on} onChange={(event) => setMedicationDraft({ ...medicationDraft, ended_on: event.target.value })} /></Field></>}
          </div>
          <Field label="备注"><textarea rows={3} className={textareaClass} value={medicationDraft.note} onChange={(event) => setMedicationDraft({ ...medicationDraft, note: event.target.value })} /></Field>
          {medicationEditing !== 'new' && <Field label="修正说明" required hint="说明为什么修改既有事实。"><Input data-testid="medication-correction-note" value={medicationDraft.correction_note} onChange={(event) => setMedicationDraft({ ...medicationDraft, correction_note: event.target.value })} /></Field>}
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setMedicationEditing(null)}>取消</Button><Button data-testid="save-medication" variant="primary" iconLeft={<Save size={16} />} loading={saving} disabled={!medicationDraft.name_raw.trim()} onClick={() => void saveMedication()}>保存用药</Button></div>
        </div>
      </Dialog>

      <Dialog open={eventEditing !== null} onClose={() => setEventEditing(null)} size="lg" title={eventEditing === 'new' ? '记录人工事件' : '修正人工事件'} description="只记录已知事实；自由文本不会被自动解释为新的临床事实。">
        <div className="space-y-4" data-testid="timeline-dialog">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="事件类型" required><Select data-testid="timeline-kind" value={eventDraft.kind} onChange={(event) => setEventDraft({ ...eventDraft, kind: event.target.value as TimelineForm['kind'] })}>{Object.entries(EVENT_KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
            <Field label="关联就诊"><Select value={eventDraft.encounter_id} onChange={(event) => setEventDraft({ ...eventDraft, encounter_id: event.target.value })}><option value="">不关联</option>{encounters.map((item) => <option key={item.id} value={item.id}>{item.occurred_on} · {item.department || item.encounter_type}</option>)}</Select></Field>
            <Field label="事件标题" required className="sm:col-span-2"><Input data-testid="timeline-title" value={eventDraft.title} onChange={(event) => setEventDraft({ ...eventDraft, title: event.target.value })} /></Field>
            <Field label="时间精度"><Select data-testid="timeline-precision" value={eventDraft.time_precision} onChange={(event) => setEventDraft({ ...eventDraft, time_precision: event.target.value as TimelineForm['time_precision'] })}><option value="minute">精确到分钟</option><option value="date">仅日期</option><option value="unknown">日期未记录</option></Select></Field>
            {eventDraft.time_precision === 'minute' ? <Field label="日期和时刻" required><Input data-testid="timeline-occurred-at" type="datetime-local" value={eventDraft.occurred_at} onChange={(event) => setEventDraft({ ...eventDraft, occurred_at: event.target.value })} /></Field> : eventDraft.time_precision === 'date' ? <Field label="临床日期" required><Input data-testid="timeline-occurred-on" type="date" value={eventDraft.occurred_on} onChange={(event) => setEventDraft({ ...eventDraft, occurred_on: event.target.value })} /></Field> : <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">该事实将进入“日期未记录”分区，系统不会用创建时间代替临床日期。</div>}
          </div>
          <Field label="备注"><textarea rows={4} className={textareaClass} value={eventDraft.note} onChange={(event) => setEventDraft({ ...eventDraft, note: event.target.value })} /></Field>
          {eventEditing !== 'new' && <Field label="修正说明" required><Input data-testid="timeline-correction-note" value={eventDraft.correction_note} onChange={(event) => setEventDraft({ ...eventDraft, correction_note: event.target.value })} /></Field>}
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setEventEditing(null)}>取消</Button><Button data-testid="save-timeline-event" variant="primary" iconLeft={<Save size={16} />} loading={saving} disabled={!eventDraft.title.trim()} onClick={() => void saveEvent()}>保存事件</Button></div>
        </div>
      </Dialog>
    </section>
  );
}
