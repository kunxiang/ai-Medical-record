import { useCallback, useEffect, useState } from 'react';
import type { EncounterT } from '@amr/contracts';
import { CalendarDays, Edit3, LoaderCircle, Plus, Save, Stethoscope, Trash2 } from 'lucide-react';
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
import { PageHeader } from '../../ui/PageHeader.js';
import { Select } from '../../ui/Select.js';
import { ContextInbox } from '../context/ContextInbox.js';
import type { BrowseSourceTarget } from '../browse/BrowseView.js';
import { ClinicalFactsPanel } from './ClinicalFactsPanel.js';
import { ObservationPanel } from './ObservationPanel.js';

const TYPE_LABEL: Record<string, string> = {
  outpatient: '门诊', inpatient: '住院', emergency: '急诊', checkup: '体检', other: '其他',
};

interface EncounterForm {
  encounter_type: 'outpatient' | 'inpatient' | 'emergency' | 'checkup' | 'other';
  occurred_on: string;
  ended_on: string;
  occurred_at: string;
  department: string;
  chief_complaint: string;
  diagnosis_text: string;
  doctor_advice: string;
}

function emptyForm(): EncounterForm {
  return {
    encounter_type: 'outpatient', occurred_on: new Date().toISOString().slice(0, 10),
    ended_on: '', occurred_at: '', department: '', chief_complaint: '', diagnosis_text: '', doctor_advice: '',
  };
}

function encounterForm(value: EncounterT): EncounterForm {
  return {
    encounter_type: value.encounter_type,
    occurred_on: value.occurred_on,
    ended_on: value.ended_on ?? '',
    occurred_at: value.occurred_at ? value.occurred_at.slice(0, 16) : '',
    department: value.department ?? '',
    chief_complaint: value.chief_complaint,
    diagnosis_text: value.diagnosis_text,
    doctor_advice: value.doctor_advice,
  };
}

export function DataView({
  person,
  people,
  onSelect,
  timezone,
  onOpenContext,
  onOpenSource,
  contextRefreshToken,
}: {
  person: Person | null;
  people: Person[];
  onSelect: (person: Person) => void;
  timezone: string;
  onOpenContext: (sessionId: string) => void;
  onOpenSource?: (target: BrowseSourceTarget) => void;
  contextRefreshToken?: number;
}): JSX.Element {
  const [encounters, setEncounters] = useState<EncounterT[]>([]);
  const [editing, setEditing] = useState<EncounterT | 'new' | null>(null);
  const [form, setForm] = useState<EncounterForm>(emptyForm);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!person) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.encounters(person.id);
      setEncounters(result.encounters);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '就诊记录加载失败');
    } finally {
      setLoading(false);
    }
  }, [person]);

  useEffect(() => { void load(); }, [load]);

  const openEditor = (value: EncounterT | 'new') => {
    setEditing(value);
    setForm(value === 'new' ? emptyForm() : encounterForm(value));
    setError(null);
  };

  const save = async () => {
    if (!person || !editing || !form.occurred_on) return;
    setSaving(true);
    setError(null);
    const common = {
      encounter_type: form.encounter_type,
      occurred_on: form.occurred_on,
      ended_on: form.ended_on || null,
      occurred_at: form.occurred_at ? new Date(form.occurred_at).toISOString() : null,
      facility_id: null,
      department: form.department || null,
      chief_complaint: form.chief_complaint,
      diagnosis_text: form.diagnosis_text,
      doctor_advice: form.doctor_advice,
    };
    try {
      if (editing === 'new') {
        await api.createEncounter(person.id, { ...common, client_operation_id: uuidv7() });
      } else {
        await api.patchEncounter(editing.id, {
          ...common,
          client_operation_id: uuidv7(),
          if_revision: editing.revision,
        });
      }
      setEditing(null);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiFailure && cause.code === 'revision_conflict'
        ? '这条就诊记录已在其他设备更新，请关闭编辑窗口并重新打开后再修改。'
        : cause instanceof Error ? cause.message : '就诊记录保存失败');
    } finally {
      setSaving(false);
    }
  };

  const archiveEncounter = async (value: EncounterT) => {
    if (!window.confirm('归档后，这次就诊将从日常列表和筛选中隐藏。是否继续？')) return;
    setSaving(true);
    setError(null);
    try {
      await api.patchEncounter(value.id, {
        client_operation_id: uuidv7(), if_revision: value.revision, archived: true,
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '归档就诊失败');
    } finally {
      setSaving(false);
    }
  };

  if (!person) {
    return <EmptyState icon={<Stethoscope />} title="请先选择档案" description="选择家庭成员后可维护就诊记录。" />;
  }

  return (
    <div className="space-y-6" data-testid="data-view">
      <PageHeader
        eyebrow="人工事实"
        title={`${person.display_name} 的数据`}
        description="维护就诊、检验指标、用药和人工事件。这里只使用人工确认事实与确定性派生，不使用未确认的智能建议代替。"
        action={<Button variant="primary" iconLeft={<Plus size={16} />} onClick={() => openEditor('new')}>新增就诊</Button>}
      />

      <div className="flex gap-2 overflow-x-auto pb-1" aria-label="选择家庭成员">
        {people.map((item) => (
          <Button key={item.id} size="sm" variant={item.id === person.id ? 'primary' : 'outline'} onClick={() => onSelect(item)}>
            {item.display_name}
          </Button>
        ))}
      </div>

      <ContextInbox
        person={person}
        timezone={timezone}
        onOpen={onOpenContext}
        refreshToken={contextRefreshToken}
      />

      <ClinicalFactsPanel person={person} encounters={encounters} onOpenSource={onOpenSource} />

      <ObservationPanel person={person} encounters={encounters} />

      {error && <Alert variant="danger"><span>{error}</span></Alert>}

      {loading ? (
        <Card className="flex items-center justify-center gap-2 py-12 text-sm text-muted"><LoaderCircle className="animate-spin" />正在加载就诊记录…</Card>
      ) : encounters.length === 0 ? (
        <EmptyState
          icon={<CalendarDays />}
          title="还没有就诊记录"
          description="可先手工建立一次门诊、住院、急诊或体检，再从文档详情把相关原件归入该次就诊。"
          action={<Button variant="primary" iconLeft={<Plus size={16} />} onClick={() => openEditor('new')}>建立第一次就诊</Button>}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {encounters.map((value) => (
            <Card key={value.id} variant="interactive" className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Badge variant="brand">{TYPE_LABEL[value.encounter_type]}</Badge>
                    <strong className="text-base text-ink">{value.occurred_on}</strong>
                  </div>
                  <p className="mt-1 text-xs text-muted">{value.department || '科室未记录'} · revision {value.revision}</p>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" iconLeft={<Edit3 size={14} />} onClick={() => openEditor(value)}>编辑</Button>
                  <Button size="sm" variant="ghost" iconLeft={<Trash2 size={14} />} disabled={saving} onClick={() => void archiveEncounter(value)}>归档</Button>
                </div>
              </div>
              <dl className="grid gap-2 text-xs">
                <div><dt className="text-muted">主诉</dt><dd className="mt-0.5 text-ink-secondary">{value.chief_complaint || '未记录'}</dd></div>
                <div><dt className="text-muted">诊断原文</dt><dd className="mt-0.5 text-ink-secondary">{value.diagnosis_text || '未记录'}</dd></div>
                <div><dt className="text-muted">医嘱原文</dt><dd className="mt-0.5 text-ink-secondary">{value.doctor_advice || '未记录'}</dd></div>
              </dl>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        size="lg"
        title={editing === 'new' ? '新增就诊' : '编辑就诊'}
        description="这些内容由你确认后直接作为 L1 人工事实保存。"
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="就诊类型" required>
              <Select value={form.encounter_type} onChange={(event) => setForm({ ...form, encounter_type: event.target.value as EncounterForm['encounter_type'] })}>
                {Object.entries(TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            </Field>
            <Field label="就诊日期" required><Input type="date" value={form.occurred_on} onChange={(event) => setForm({ ...form, occurred_on: event.target.value })} /></Field>
            <Field label="结束日期"><Input type="date" value={form.ended_on} onChange={(event) => setForm({ ...form, ended_on: event.target.value })} /></Field>
            <Field label="精确时间"><Input type="datetime-local" value={form.occurred_at} onChange={(event) => setForm({ ...form, occurred_at: event.target.value })} /></Field>
            <Field label="科室" className="sm:col-span-2"><Input value={form.department} onChange={(event) => setForm({ ...form, department: event.target.value })} /></Field>
          </div>
          {([
            ['chief_complaint', '主诉'], ['diagnosis_text', '诊断原文'], ['doctor_advice', '医嘱原文'],
          ] as const).map(([field, label]) => (
            <Field key={field} label={label} htmlFor={`encounter-${field}`}>
              <textarea
                id={`encounter-${field}`}
                rows={3}
                value={form[field]}
                onChange={(event) => setForm({ ...form, [field]: event.target.value })}
                className="w-full rounded-xl border border-line px-3.5 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
              />
            </Field>
          ))}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
            <Button variant="primary" iconLeft={<Save size={16} />} loading={saving} disabled={!form.occurred_on} onClick={() => void save()}>保存就诊</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
