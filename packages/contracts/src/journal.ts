import { z } from 'zod';
import { DocShortId, IsoDateTime, PersonSlug, Sha256Hex, Uuid } from './scalars.js';
import { PersonSidecar } from './person.js';
import { DocumentManualMetadataSnapshot } from './metadata.js';
import { Encounter } from './encounter.js';
import {
  ContextAnswer, ContextSession, ContextUploadSnapshot,
} from './context.js';
import {
  ConceptAliasDecision, MedicalConcept, Observation,
} from './observation.js';
import { MetricGroup } from './trends.js';
import { Medication, TimelineEvent } from './medication.js';

// spec m0-01 §5:M0 只有 person_update。后续里程碑向 union 追加;
// 禁止修改已有事件 schema(只能加新 schema_version)。
export const JournalPersonUpdate = z
  .object({
    schema_version: z.literal('1.0'),
    event: z.literal('person_update'),
    event_id: Uuid, // uuid v7,回放幂等键
    at: IsoDateTime,
    by_account_id: Uuid,
    person: PersonSidecar,
  })
  .strict();

// M1:曾拍摄但放弃 —— 无法从任何原件重建的人工层事实(m1-01 §B4)
export const JournalCaptureDiscard = z
  .object({
    schema_version: z.literal('1.0'),
    event: z.literal('capture_discard'),
    event_id: Uuid,                 // = 请求的 discard_event_id
    at: IsoDateTime,
    by_account_id: Uuid,
    client_document_id: z.string().min(8).max(64),
    person_slug: z.string(),
    captured_at: IsoDateTime,
    page_count: z.number().int().min(1),
    reason: z.enum(['user_discarded', 'terminal_error']),
    detail: z.string().max(500).nullable(),
  })
  .strict();


// ── M2:五类人的判断(m2-01 §4.1)──
// 分界线(m2-00 §4.4):模型说的话可以重来(L2,不进 journal),人说的话不能。

const M2Base = {
  schema_version: z.literal('1.0'),
  event_id: Uuid,
  at: IsoDateTime,
  by_account_id: Uuid,
  client_operation_id: Uuid,       // 幂等键:弱网重发不得写出第二条只增不改的 L1 记录
};

/** 归人告警确认。载荷必须自带判断依据 —— 依据不能只存在于可丢的 L2 工件里(审核 #004 C-4) */
export const JournalPersonCheckAck = z
  .object({
    ...M2Base,
    event: z.literal('person_check_ack'),
    document_short_id: DocShortId,
    from_check: z.enum(['mismatch', 'unknown']),
    observed_name: z.string().nullable(),   // S1 当时读出的姓名快照
    expected_name: z.string(),              // 当时的 person.display_name 快照
    reason: z.string().max(500),
  })
  .strict();

export const JournalPersonReassign = z
  .object({
    ...M2Base,
    event: z.literal('person_reassign'),
    document_short_id: DocShortId,
    from_person_slug: PersonSlug,
    to_person_slug: PersonSlug,
    reason: z.string().max(500),
    correction_seq: z.number().int().min(1),
  })
  .strict();

export const JournalDocumentArchive = z
  .object({
    ...M2Base,
    event: z.literal('document_archive'),
    document_short_id: DocShortId,
    archived: z.boolean(),
    reason: z.string().max(500),
  })
  .strict();

const boundaryFields = {
  from_doc_short_id: DocShortId,
  to_doc_short_id: DocShortId,
  page_sha256: z.array(Sha256Hex).min(1),   // 用内容摘要定位页(ADR-047:key 中的 NN 永不改名)
};
export const JournalDocumentSplit = z
  .object({ ...M2Base, event: z.literal('document_split'), ...boundaryFields }).strict();
export const JournalDocumentMerge = z
  .object({ ...M2Base, event: z.literal('document_merge'), ...boundaryFields }).strict();
export const JournalDocumentMovePage = z
  .object({ ...M2Base, event: z.literal('document_move_page'), ...boundaryFields }).strict();

export const OperationReplay = z.object({
  request_hash: Sha256Hex,
  response_snapshot: z.record(z.unknown()),
}).strict();

export const FacilitySnapshot = z.object({
  id: Uuid,
  slug: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  city: z.string().nullable(),
  level: z.string().nullable(),
}).strict();

const P0FactBase = {
  ...M2Base,
  person_slug: PersonSlug,
  subject_id: Uuid,
  revision: z.number().int().min(1),
  operation_replay: OperationReplay,
};

export const JournalDocumentMetadataUpsert = z.object({
  ...P0FactBase,
  event: z.literal('document_metadata_upsert'),
  before: DocumentManualMetadataSnapshot.nullable(),
  after: DocumentManualMetadataSnapshot,
  references: z.object({
    facility: FacilitySnapshot.nullable(),
    suggestion: z.record(z.unknown()).nullable(),
  }).strict(),
}).strict();

export const JournalEncounterUpsert = z.object({
  ...P0FactBase,
  event: z.literal('encounter_upsert'),
  before: Encounter.nullable(),
  after: Encounter,
  references: z.object({ facility: FacilitySnapshot.nullable() }).strict(),
}).strict();

export const JournalEncounterDocumentsSet = z.object({
  ...P0FactBase,
  event: z.literal('encounter_documents_set'),
  before_document_ids: z.array(Uuid),
  after_document_ids: z.array(Uuid),
  after: Encounter,
  references: z.object({ facility: FacilitySnapshot.nullable() }).strict(),
}).strict();

export const JournalContextSessionUpsert = z.object({
  ...P0FactBase,
  event: z.literal('context_session_upsert'),
  before: ContextSession.nullable(),
  after: ContextSession,
  references: z.object({}).strict(),
}).strict();

export const JournalContextAnswerUpsert = z.object({
  ...P0FactBase,
  event: z.literal('context_answer_upsert'),
  before: z.array(ContextAnswer),
  after: z.array(ContextAnswer),
  session_after: ContextSession,
  references: z.object({}).strict(),
}).strict();

export const JournalContextMediaFinalize = z.object({
  ...P0FactBase,
  event: z.literal('context_media_finalize'),
  before: z.null(),
  after: ContextUploadSnapshot,
  references: z.object({}).strict(),
}).strict();

export const JournalObservationUpsert = z.object({
  ...P0FactBase,
  event: z.literal('observation_upsert'),
  before: z.array(Observation),
  after: z.array(Observation).min(1).max(100),
  correction_note: z.string().max(2_000).nullable(),
  references: z.object({
    concepts: z.array(MedicalConcept),
    facilities: z.array(FacilitySnapshot),
    suggestion: z.record(z.unknown()).nullable().default(null),
  }).strict(),
}).strict();

export const JournalConceptAliasUpsert = z.object({
  ...P0FactBase,
  event: z.literal('concept_alias_upsert'),
  before: ConceptAliasDecision.nullable(),
  after: ConceptAliasDecision,
  observations_before: z.array(Observation),
  observations_after: z.array(Observation).max(100),
  references: z.object({ concept: MedicalConcept }).strict(),
}).strict();

export const JournalMetricGroupUpsert = z.object({
  ...P0FactBase,
  event: z.literal('metric_group_upsert'),
  before: MetricGroup.nullable(),
  after: MetricGroup,
  references: z.object({}).strict(),
}).strict();

export const JournalMetricGroupArchive = z.object({
  ...P0FactBase,
  event: z.literal('metric_group_archive'),
  before: MetricGroup,
  after: MetricGroup,
  references: z.object({}).strict(),
}).strict();

export const JournalMedicationUpsert = z.object({
  ...P0FactBase,
  event: z.literal('medication_upsert'),
  before: z.array(Medication),
  after: z.array(Medication).min(1).max(100),
  correction_note: z.string().max(2_000).nullable(),
  references: z.object({}).strict(),
}).strict();

export const JournalTimelineEventUpsert = z.object({
  ...P0FactBase,
  event: z.literal('timeline_event_upsert'),
  before: TimelineEvent.nullable(),
  after: TimelineEvent,
  correction_note: z.string().max(2_000).nullable(),
  references: z.object({}).strict(),
}).strict();

export const JournalEvent = z.discriminatedUnion('event', [
  JournalPersonUpdate, JournalCaptureDiscard,
  JournalPersonCheckAck, JournalPersonReassign, JournalDocumentArchive,
  JournalDocumentSplit, JournalDocumentMerge, JournalDocumentMovePage,
  JournalDocumentMetadataUpsert, JournalEncounterUpsert, JournalEncounterDocumentsSet,
  JournalContextSessionUpsert, JournalContextAnswerUpsert, JournalContextMediaFinalize,
  JournalObservationUpsert, JournalConceptAliasUpsert,
  JournalMetricGroupUpsert, JournalMetricGroupArchive,
  JournalMedicationUpsert, JournalTimelineEventUpsert,
]);

// 事件注册表(_meta/registries 与 README 的内容来源)
export const JOURNAL_EVENT_REGISTRY = [
  'person_update', 'capture_discard',
  'person_check_ack', 'person_reassign', 'document_archive',
  'document_split', 'document_merge', 'document_move_page',
  'document_metadata_upsert', 'encounter_upsert', 'encounter_documents_set',
  'context_session_upsert', 'context_answer_upsert', 'context_media_finalize',
  'observation_upsert', 'concept_alias_upsert',
  'metric_group_upsert', 'metric_group_archive',
  'medication_upsert', 'timeline_event_upsert',
] as const;

// ── M2:不绑人的判断落 _index/decisions/(m2-01 §4.2)──
// facility 归一是**全家共享词表**(docs/04 §1 矩阵、ADR-040),不属于任何一个 person。
// 硬塞进 per-person journal 会让词表被随机切碎散落进 N 个人的档案里,
// 单人导出时孩子拿到父母档案触发的机构决策,或反过来自己缺词表(审核 #004 A-2)。
export const DecisionNormalizationConfirm = z
  .object({
    schema_version: z.literal('1.0'),
    event_id: Uuid,
    op: z.literal('normalization_confirm'),
    at: IsoDateTime,
    by_account_id: Uuid,
    client_operation_id: Uuid,
    kind: z.enum(['facility', 'encounter']),
    input_fingerprint: Sha256Hex,
    decision: z.enum(['confirmed', 'rejected']),
    // ★ 载荷必须自带重建 facility 行所需的全部事实 —— facility 表不在任何 L1 对象里,
    //   删库即消失(m2-07 §5)。
    payload: z.record(z.unknown()),
  })
  .strict();
export const DecisionLine = z.discriminatedUnion('op', [DecisionNormalizationConfirm]);
export const DECISION_OP_REGISTRY = ['normalization_confirm'] as const;

// ── 系统级审计(D11,m1-02 §5)——与 journal 分开:它记的是权限,不是人工判断 ──
export const AuditAccessGrant = z
  .object({
    schema_version: z.literal('1.0'),
    event_id: Uuid,
    op: z.enum(['access_grant', 'access_revoke']),
    account_id: Uuid,
    person_id: Uuid,
    person_slug: z.string(),
    role: z.enum(['owner', 'editor', 'viewer']),
    at: IsoDateTime,
  })
  .strict();
/** 文档删除审计(D11 的文档删除部分,M1 时移交 M2)。
 *  缺了它 appendAudit 的 parse 会直接抛错,m2-99 A20 过不去(审核 #004 C-2)。 */
export const AuditDocumentArchive = z
  .object({
    schema_version: z.literal('1.0'),
    event_id: Uuid,
    op: z.literal('document_archive'),
    account_id: Uuid,
    document_short_id: DocShortId,
    person_slug: z.string(),
    archived: z.boolean(),
    reason: z.string().max(500),
    at: IsoDateTime,
  })
  .strict();
export const AuditLine = z.discriminatedUnion('op', [AuditAccessGrant, AuditDocumentArchive]);
