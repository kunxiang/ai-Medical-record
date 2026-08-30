import {
  ContextTemplateDefinition,
  ContextTemplateManifestResponse,
  ContextTemplateSnapshot,
  type ContextQuestionT,
  type ContextTemplateDefinitionT,
  type ContextTemplateSnapshotT,
} from '@amr/contracts';

const option = (value: string, label: string) => ({ value, label });

const definitions = [
  {
    template_id: 'lab-report', version: 1, doc_types: ['lab_report'],
    stages: {
      onsite: {
        max_questions: 6,
        questions: [
          {
            key: 'fasting_status', text: '这次抽血是空腹吗？', answer_type: 'choice',
            options: [option('fasting', '空腹（≥8小时）'), option('non_fasting', '没空腹'), option('unknown', '不确定')],
            maps_to: 'observation_context.fasting',
          },
          {
            key: 'collection_time', text: '大概什么时候抽的血？', answer_type: 'datetime',
            maps_to: 'observation_context.collected_at',
          },
          {
            key: 'visit_reason', text: '今天为什么来医院？', answer_type: 'audio',
            allow_text_fallback: true, max_duration_ms: 60_000,
            maps_to: 'encounter.chief_complaint', timeline_kind: 'visit_reason',
            event_time_source: 'session_started_at',
          },
          {
            key: 'current_symptoms', text: '最近有什么不舒服吗？', answer_type: 'audio',
            allow_text_fallback: true, max_duration_ms: 60_000,
            timeline_kind: 'symptom', event_time_source: 'session_started_at',
          },
          {
            key: 'recent_illness', text: '最近两周有没有发热、感染或剧烈运动？', answer_type: 'multi_choice',
            options: [
              option('fever', '发热'), option('infection', '感染'), option('intense_exercise', '剧烈运动'),
              option('none', '都没有'), option('unknown', '不确定'),
            ],
            maps_to: 'observation_context.recent_illness',
          },
        ],
      },
      same_day: {
        max_questions: 4,
        questions: [
          {
            key: 'doctor_advice', text: '医生说了什么？', answer_type: 'audio',
            allow_text_fallback: true, max_duration_ms: 120_000,
            maps_to: 'encounter.doctor_advice', timeline_kind: 'doctor_advice',
            event_time_source: 'session_started_at',
          },
          {
            key: 'medication_changes', text: '有没有开新药或调整用药？', answer_type: 'audio',
            allow_text_fallback: true, max_duration_ms: 120_000,
            timeline_kind: 'medication_change', event_time_source: 'session_started_at',
          },
          {
            key: 'medication_photo', text: '如果方便，可以拍下药盒或处方', answer_type: 'photo',
          },
          {
            key: 'followup_plan', text: '下次计划什么时候复查？', answer_type: 'date',
            timeline_kind: 'followup_plan', event_time_source: 'answer_value',
          },
        ],
      },
    },
    conditional: [{
      when: { sex_at_birth: 'female', age_between: [12, 55] }, append_to: 'onsite',
      questions: [{
        key: 'menstrual_phase', text: '目前处于月经周期的哪个阶段？', answer_type: 'choice',
        options: [
          option('menstruation', '月经期'), option('follicular', '卵泡期'), option('luteal', '黄体期'),
          option('unknown', '不确定'), option('not_applicable', '不适用'),
        ],
        maps_to: 'observation_context.menstrual_phase',
      }],
    }],
  },
  {
    template_id: 'imaging-report', version: 1, doc_types: ['imaging_report', 'pathology', 'ecg'],
    stages: {
      onsite: {
        max_questions: 3,
        questions: [
          {
            key: 'exam_reason', text: '为什么做这个检查？', answer_type: 'audio',
            allow_text_fallback: true, max_duration_ms: 60_000,
            timeline_kind: 'visit_reason', event_time_source: 'session_started_at',
          },
          {
            key: 'contrast_used', text: '有没有使用造影剂？', answer_type: 'choice',
            options: [option('yes', '有'), option('no', '没有'), option('unknown', '不确定')],
          },
          {
            key: 'prior_comparison', text: '报告里有没有和以前的检查对比？', answer_type: 'choice',
            options: [option('yes', '有'), option('no', '没有'), option('unknown', '不确定')],
          },
        ],
      },
      same_day: {
        max_questions: 1,
        questions: [{
          key: 'doctor_advice', text: '医生怎么解读的？', answer_type: 'audio',
          allow_text_fallback: true, max_duration_ms: 120_000,
          timeline_kind: 'doctor_advice', event_time_source: 'session_started_at',
        }],
      },
    },
  },
  {
    template_id: 'prescription', version: 1, doc_types: ['prescription', 'infusion_order'],
    stages: {
      onsite: {
        max_questions: 4,
        questions: [
          {
            key: 'is_new_medication', text: '这是新开的药还是续方？', answer_type: 'choice',
            options: [option('new', '新开'), option('renewal', '续方'), option('unknown', '不确定')],
          },
          {
            key: 'indication', text: '这些药是针对什么问题开的？', answer_type: 'audio',
            allow_text_fallback: true, max_duration_ms: 60_000,
            timeline_kind: 'visit_reason', event_time_source: 'session_started_at',
          },
          { key: 'duration', text: '计划用多久？', answer_type: 'text' },
          {
            key: 'prior_med_stopped', text: '有没有停掉哪个药？', answer_type: 'audio',
            allow_text_fallback: true, max_duration_ms: 60_000,
            timeline_kind: 'medication_change', event_time_source: 'session_started_at',
          },
        ],
      },
    },
  },
  {
    template_id: 'checkup-report', version: 1, doc_types: ['checkup_report'],
    stages: {
      onsite: {
        max_questions: 4,
        questions: [
          {
            key: 'checkup_type', text: '这是哪种体检？', answer_type: 'choice',
            options: [option('employer', '单位体检'), option('self_paid', '自费体检'), option('employment', '入职体检'), option('other', '其他')],
          },
          {
            key: 'fasting_status', text: '抽血时是空腹吗？', answer_type: 'choice',
            options: [option('fasting', '空腹'), option('non_fasting', '非空腹'), option('unknown', '不确定')],
            maps_to: 'observation_context.fasting',
          },
          {
            key: 'fasting_hours', text: '如果记得，大约空腹了几小时？', answer_type: 'number',
            number_min: 0, number_max: 48, maps_to: 'observation_context.fasting_hours',
          },
          {
            key: 'abnormal_noted', text: '报告里标了哪些异常？', answer_type: 'audio',
            allow_text_fallback: true, max_duration_ms: 90_000,
          },
        ],
      },
    },
  },
  {
    template_id: 'generic', version: 1,
    doc_types: ['discharge_summary', 'outpatient_note', 'vaccination', 'other', 'unknown'],
    stages: {
      onsite: {
        max_questions: 2,
        questions: [
          {
            key: 'what_is_this', text: '这是什么单据？', answer_type: 'audio',
            allow_text_fallback: true, max_duration_ms: 60_000,
          },
          {
            key: 'visit_reason', text: '当时为什么去的？', answer_type: 'audio',
            allow_text_fallback: true, max_duration_ms: 60_000,
            timeline_kind: 'visit_reason', event_time_source: 'session_started_at',
          },
        ],
      },
      anytime: {
        max_questions: 2,
        questions: [
          {
            key: 'event_date', text: '这件事大约发生在哪天？', answer_type: 'date',
            timeline_kind: 'other', event_time_source: 'answer_value',
          },
          {
            key: 'event_note', text: '记录当时的情况', answer_type: 'text',
            timeline_kind: 'other', event_time_source: 'session_started_at',
          },
        ],
      },
    },
  },
] as const;

export const CONTEXT_TEMPLATE_DEFINITIONS: readonly ContextTemplateDefinitionT[] = definitions.map(
  (definition) => ContextTemplateDefinition.parse(definition),
);

// Hash 只覆盖 parse 后的 definition（不包含 hash 字段）。测试会重算并防止模板漂移。
export const CONTEXT_TEMPLATE_HASHES = {
  'lab-report@1': '2f40f461d0c7890720faae3c393d42fb1af768e350a3c9292c65e6d79e6b3325',
  'imaging-report@1': '51acf63d1b03e1c43a7321c343364678a2d50bad75c650cea0157fb227117bd5',
  'prescription@1': '0710a55fcb25af00a942f0bbffc6a090e7348a527fc4f82b02682bb66c481549',
  'checkup-report@1': 'f37751aa9dcbcbc206f2c09e1835396eae18fd168ef28749c51e6fbd0ef81f67',
  'generic@1': '03ea4d279b3d25fe46dda915df18f52509d6343718b9f78ac8fe707bf0be2520',
} as const;

function templateKey(templateId: string, version: number): keyof typeof CONTEXT_TEMPLATE_HASHES | null {
  const key = `${templateId}@${version}`;
  return Object.prototype.hasOwnProperty.call(CONTEXT_TEMPLATE_HASHES, key)
    ? key as keyof typeof CONTEXT_TEMPLATE_HASHES : null;
}

export function getContextTemplate(templateId: string, version: number): ContextTemplateSnapshotT | null {
  const definition = CONTEXT_TEMPLATE_DEFINITIONS.find(
    (candidate) => candidate.template_id === templateId && candidate.version === version,
  );
  const key = templateKey(templateId, version);
  if (!definition || !key) return null;
  return ContextTemplateSnapshot.parse({ ...definition, template_hash: CONTEXT_TEMPLATE_HASHES[key] });
}

export function contextTemplateManifest() {
  const grouped = new Map<string, ContextTemplateDefinitionT[]>();
  for (const definition of CONTEXT_TEMPLATE_DEFINITIONS) {
    grouped.set(definition.template_id, [...(grouped.get(definition.template_id) ?? []), definition]);
  }
  return ContextTemplateManifestResponse.parse({
    manifest_version: 1,
    templates: [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
      ([templateId, versions]) => ({
        template_id: templateId,
        latest_version: Math.max(...versions.map((version) => version.version)),
        versions: versions.sort((left, right) => left.version - right.version).map((version) => ({
          version: version.version,
          hash: CONTEXT_TEMPLATE_HASHES[templateKey(templateId, version.version)!],
        })),
        doc_types: [...new Set(versions.flatMap((version) => version.doc_types))],
      }),
    ),
  });
}

export interface ContextTemplatePerson {
  sex_at_birth: 'male' | 'female' | 'unknown';
  age: number;
}

function conditionMatches(
  condition: ContextTemplateDefinitionT['conditional'][number]['when'],
  person: ContextTemplatePerson,
): boolean {
  if (condition.sex_at_birth !== undefined && condition.sex_at_birth !== person.sex_at_birth) return false;
  if (condition.age_between !== undefined
      && (person.age < condition.age_between[0] || person.age > condition.age_between[1])) return false;
  return true;
}

export function resolveContextQuestions(
  template: ContextTemplateDefinitionT,
  stage: 'onsite' | 'same_day' | 'anytime',
  person: ContextTemplatePerson,
): ContextQuestionT[] {
  const base = template.stages[stage]?.questions ?? [];
  const appended = template.conditional
    .filter((condition) => condition.append_to === stage && conditionMatches(condition.when, person))
    .flatMap((condition) => condition.questions);
  const result = [...base, ...appended];
  if (new Set(result.map((question) => question.key)).size !== result.length) {
    throw new Error(`context template ${template.template_id}@${template.version} 解析后问题 key 重复`);
  }
  const maximum = template.stages[stage]?.max_questions ?? 0;
  if (result.length > maximum) {
    throw new Error(`context template ${template.template_id}@${template.version} 超过 ${stage} max_questions`);
  }
  return result;
}
