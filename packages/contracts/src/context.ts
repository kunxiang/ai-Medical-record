import { z } from 'zod';
import { IsoDate, IsoDateTime, Sha256Hex, Uuid } from './scalars.js';
import { DocType } from './enums.js';
import {
  Observation, ObservationBatchDefaults, ObservationBatchRow, ObservationWarning,
} from './observation.js';
import { Medication, MedicationBatchRow, MedicationWarning } from './medication.js';

export const ContextScopeType = z.enum(['document', 'standalone']);
export const ContextStage = z.enum(['onsite', 'same_day', 'anytime']);
export const ContextSessionStatus = z.enum(['active', 'completed']);
export const ContextAnswerType = z.enum([
  'choice', 'multi_choice', 'number', 'text', 'date', 'datetime', 'audio', 'photo',
]);
export const ContextTimelineKind = z.enum([
  'symptom', 'visit_reason', 'doctor_advice', 'medication_change', 'followup_plan', 'other',
]);
export const ContextEventTimeSource = z.enum([
  'answer_value', 'document_sampled_on', 'session_started_at', 'none',
]);

export const ContextQuestionOption = z.object({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(120),
}).strict();

export const ContextQuestion = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  text: z.string().min(1).max(500),
  answer_type: ContextAnswerType,
  options: z.array(ContextQuestionOption).max(30).default([]),
  skippable: z.boolean().default(true),
  allow_text_fallback: z.boolean().default(false),
  max_duration_ms: z.number().int().min(500).max(300_000).nullable().default(null),
  number_min: z.number().nullable().default(null),
  number_max: z.number().nullable().default(null),
  maps_to: z.string().min(1).max(200).nullable().default(null),
  timeline_kind: ContextTimelineKind.nullable().default(null),
  event_time_source: ContextEventTimeSource.default('none'),
}).strict().superRefine((question, ctx) => {
  const choice = question.answer_type === 'choice' || question.answer_type === 'multi_choice';
  if (choice && question.options.length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: '选择题至少需要两个选项' });
  }
  if (!choice && question.options.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: '非选择题不得声明 options' });
  }
  if (question.allow_text_fallback && question.answer_type !== 'audio') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allow_text_fallback'], message: '仅录音题可声明文字替代' });
  }
  if (question.max_duration_ms !== null && question.answer_type !== 'audio') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['max_duration_ms'], message: '仅录音题可限制时长' });
  }
  if ((question.number_min !== null || question.number_max !== null) && question.answer_type !== 'number') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['number_min'], message: '仅数字题可声明数值范围' });
  }
  if (question.number_min !== null && question.number_max !== null
      && question.number_min > question.number_max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['number_max'], message: '上限不得小于下限' });
  }
  if (question.event_time_source === 'answer_value'
      && question.answer_type !== 'date' && question.answer_type !== 'datetime') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['event_time_source'],
      message: 'answer_value 仅适用于 date/datetime 题',
    });
  }
  if (question.timeline_kind === null && question.event_time_source !== 'none') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['event_time_source'],
      message: '非 timeline 问题的 event_time_source 必须为 none',
    });
  }
}).transform((question) => question);

export const ContextTemplateStage = z.object({
  max_questions: z.number().int().min(1).max(30),
  questions: z.array(ContextQuestion).min(1).max(30),
}).strict().superRefine((stage, ctx) => {
  if (stage.questions.length > stage.max_questions) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['questions'], message: '问题数超过 max_questions' });
  }
  if (new Set(stage.questions.map((question) => question.key)).size !== stage.questions.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['questions'], message: '问题 key 不得重复' });
  }
});

export const ContextTemplateCondition = z.object({
  when: z.object({
    sex_at_birth: z.enum(['male', 'female', 'unknown']).optional(),
    age_between: z.tuple([z.number().int().min(0).max(150), z.number().int().min(0).max(150)]).optional(),
  }).strict(),
  append_to: ContextStage,
  questions: z.array(ContextQuestion).min(1).max(10),
}).strict().superRefine((condition, ctx) => {
  if (condition.when.sex_at_birth === undefined && condition.when.age_between === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['when'], message: '条件不得为空' });
  }
  if (condition.when.age_between && condition.when.age_between[0] > condition.when.age_between[1]) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['when', 'age_between'], message: '年龄范围无效' });
  }
});

const contextTemplateShape = {
  template_id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  version: z.number().int().min(1),
  doc_types: z.array(DocType).min(1),
  stages: z.object({
    onsite: ContextTemplateStage.optional(),
    same_day: ContextTemplateStage.optional(),
    anytime: ContextTemplateStage.optional(),
  }).strict(),
  conditional: z.array(ContextTemplateCondition).max(20).default([]),
};
const ContextTemplateObject = z.object(contextTemplateShape).strict();
type ContextTemplateObjectT = z.infer<typeof ContextTemplateObject>;

function validateTemplate(
  template: ContextTemplateObjectT,
  ctx: z.RefinementCtx,
): void {
  if (Object.values(template.stages).every((stage) => stage === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stages'], message: '至少需要一个 stage' });
  }
  const keys = Object.values(template.stages).flatMap((stage) => stage?.questions.map((question) => question.key) ?? []);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stages'], message: '同一模板的基础问题 key 不得重复' });
  }
}

export const ContextTemplateDefinition = ContextTemplateObject.superRefine(validateTemplate);

export const ContextTemplateSnapshot = z.object({
  ...contextTemplateShape,
  template_hash: Sha256Hex,
}).strict().superRefine(validateTemplate);

export const ContextTemplateManifestEntry = z.object({
  template_id: z.string(),
  latest_version: z.number().int().min(1),
  versions: z.array(z.object({ version: z.number().int().min(1), hash: Sha256Hex }).strict()).min(1),
  doc_types: z.array(DocType),
}).strict();
export const ContextTemplateManifestResponse = z.object({
  manifest_version: z.literal(1),
  templates: z.array(ContextTemplateManifestEntry),
}).strict();

export const ContextSessionCreate = z.object({
  client_operation_id: Uuid,
  id: Uuid,
  person_id: Uuid,
  scope_type: ContextScopeType,
  scope_key: z.string().min(8).max(64),
  client_document_id: z.string().min(8).max(64).nullable(),
  document_id: z.null().default(null),
  encounter_id: Uuid.nullable().default(null),
  template_id: z.string().min(2).max(64),
  template_version: z.number().int().min(1),
  template_hash: Sha256Hex,
  question_snapshot: z.array(ContextQuestion).min(1).max(100),
  stage: ContextStage,
}).strict().superRefine((session, ctx) => {
  if (session.scope_type === 'document' && session.client_document_id === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['client_document_id'], message: 'document scope 必须有 client_document_id' });
  }
  if (session.scope_type === 'standalone' && session.client_document_id !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['client_document_id'], message: 'standalone scope 不得伪造文档' });
  }
  if (session.scope_type === 'document' && session.scope_key !== session.client_document_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scope_key'], message: 'document scope_key 必须等于 client_document_id' });
  }
});

export const ContextSession = z.object({
  id: Uuid,
  person_id: Uuid,
  scope_type: ContextScopeType,
  scope_key: z.string().min(8).max(64),
  client_document_id: z.string().min(8).max(64).nullable(),
  document_id: Uuid.nullable(),
  encounter_id: Uuid.nullable(),
  template_id: z.string(),
  template_version: z.number().int().min(1),
  template_hash: Sha256Hex,
  question_snapshot: z.array(ContextQuestion),
  stage: ContextStage,
  status: ContextSessionStatus,
  revision: z.number().int().min(1),
  created_by: Uuid,
  created_at: IsoDateTime,
  updated_by: Uuid,
  updated_at: IsoDateTime,
  completed_at: IsoDateTime.nullable(),
}).strict();

const answerBase = {
  question_key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  answered_at: IsoDateTime.nullable().default(null),
};
const answered = <T extends z.ZodTypeAny>(answerType: z.infer<typeof ContextAnswerType>, value: T) => z.object({
  ...answerBase,
  answer_type: z.literal(answerType),
  value,
  skipped: z.literal(false),
}).strict();

export const ContextAnswerInput = z.union([
  answered('choice', z.string().min(1).max(100)),
  answered('multi_choice', z.array(z.string().min(1).max(100)).min(1).max(30)
    .refine((values) => new Set(values).size === values.length, '选项不得重复')),
  answered('number', z.number().finite()),
  answered('text', z.string().max(10_000)),
  answered('date', IsoDate),
  answered('datetime', IsoDateTime),
  answered('audio', z.object({ upload_id: Uuid }).strict()),
  answered('photo', z.object({ upload_id: Uuid }).strict()),
  z.object({
    ...answerBase,
    answer_type: ContextAnswerType,
    value: z.null(),
    skipped: z.literal(true),
  }).strict(),
]);

export const ContextAnswersUpsertRequest = z.object({
  client_operation_id: Uuid,
  if_revision: z.number().int().min(1),
  answers: z.array(ContextAnswerInput).min(1).max(30),
}).strict().superRefine((request, ctx) => {
  if (new Set(request.answers.map((answer) => answer.question_key)).size !== request.answers.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers'], message: '同一批次的 question_key 不得重复' });
  }
});

export const ContextAnswer = z.object({
  id: Uuid,
  session_id: Uuid,
  question_key: z.string(),
  question_text: z.string(),
  question_snapshot: ContextQuestion,
  answer_type: ContextAnswerType,
  value: z.unknown().nullable(),
  upload_id: Uuid.nullable(),
  skipped: z.boolean(),
  answered_at: IsoDateTime.nullable(),
  event_on: IsoDate.nullable(),
  event_at: IsoDateTime.nullable(),
  time_precision: z.enum(['date', 'minute', 'unknown']).nullable(),
  event_time_source: ContextEventTimeSource.nullable(),
  revision: z.number().int().min(1),
  updated_by: Uuid,
  updated_at: IsoDateTime,
}).strict();

export const ContextSessionDetailResponse = z.object({
  session: ContextSession,
  answers: z.array(ContextAnswer),
}).strict();
export const ContextSessionMutationResponse = ContextSessionDetailResponse;

export const ContextSessionBindRequest = z.object({
  client_operation_id: Uuid,
  if_revision: z.number().int().min(1),
}).strict();
export const ContextSessionCompleteRequest = ContextSessionBindRequest;

export const ContextPendingQuery = z.object({
  person_id: Uuid,
  local_date: IsoDate,
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();
export const ContextPendingResponse = z.object({
  sessions: z.array(ContextSession),
  next_cursor: z.string().nullable(),
}).strict();

export const ContextMediaKind = z.enum(['audio', 'photo']);
export const ContextMediaMime = z.enum([
  'audio/mp4', 'audio/webm', 'audio/mpeg', 'audio/wav',
  'image/jpeg', 'image/png', 'image/webp',
]);
export const ContextUploadState = z.enum(['prepared', 'uploading', 'finalized', 'expired']);
export const CONTEXT_AUDIO_MAX_BYTES = 25 * 1024 * 1024;
export const CONTEXT_PHOTO_MAX_BYTES = 50 * 1024 * 1024;

export const ContextUploadPrepareRequest = z.object({
  client_operation_id: Uuid,
  person_id: Uuid,
  session_id: Uuid,
  question_key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  kind: ContextMediaKind,
  mime: ContextMediaMime,
  byte_size: z.number().int().min(1).max(CONTEXT_PHOTO_MAX_BYTES),
  sha256: Sha256Hex,
}).strict().superRefine((upload, ctx) => {
  if (upload.kind === 'audio' && !upload.mime.startsWith('audio/')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mime'], message: 'audio 必须使用音频 MIME' });
  }
  if (upload.kind === 'photo' && !upload.mime.startsWith('image/')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mime'], message: 'photo 必须使用图片 MIME' });
  }
  if (upload.kind === 'audio' && upload.byte_size > CONTEXT_AUDIO_MAX_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['byte_size'], message: '录音文件超过上限' });
  }
});

export const ContextUpload = z.object({
  id: Uuid,
  person_id: Uuid,
  session_id: Uuid,
  question_key: z.string(),
  kind: ContextMediaKind,
  mime: ContextMediaMime,
  byte_size: z.number().int().positive(),
  sha256: Sha256Hex,
  state: ContextUploadState,
  created_at: IsoDateTime,
  finalized_at: IsoDateTime.nullable(),
}).strict();
export const ContextUploadSnapshot = ContextUpload.extend({
  object_key: z.string().min(1).max(1024),
  multipart_state: z.record(z.unknown()).nullable(),
  created_by: Uuid,
}).strict();
export const ContextUploadPrepareResponse = ContextUpload;
export const ContextUploadPart = z.object({
  part_number: z.number().int().min(1).max(10_000),
  url: z.string().url(),
}).strict();
export const ContextUploadPresignResponse = z.discriminatedUnion('mode', [
  z.object({
    upload: ContextUpload,
    mode: z.literal('single'),
    method: z.literal('PUT'),
    url: z.string().url(),
    headers: z.record(z.string()),
    expires_at: IsoDateTime,
    part_size: z.null(),
    part_count: z.null(),
    parts: z.array(ContextUploadPart).max(0),
  }).strict(),
  z.object({
    upload: ContextUpload,
    mode: z.literal('multipart'),
    method: z.literal('PUT'),
    url: z.null(),
    headers: z.record(z.string()),
    expires_at: IsoDateTime,
    part_size: z.number().int().positive(),
    part_count: z.number().int().min(2).max(10_000),
    parts: z.array(ContextUploadPart).min(2).max(10_000),
  }).strict(),
]);
export const ContextUploadFinalizeRequest = z.object({
  client_operation_id: Uuid,
  parts: z.array(z.object({
    part_number: z.number().int().min(1).max(10_000),
    etag: z.string().min(1).max(512),
  }).strict()).max(10_000).default([]),
}).strict();
export const ContextUploadFinalizeResponse = z.object({ upload: ContextUpload }).strict();
export const ContextUploadViewResponse = z.object({
  upload: ContextUpload,
  url: z.string().url(),
  expires_at: IsoDateTime,
}).strict();

// maps_to 只用于 UI 预填提示。真正写入其他 L1 fact 必须经过这个显式确认契约。
export const ContextAnswerPromoteRequest = z.discriminatedUnion('target_type', [
  z.object({
    client_operation_id: Uuid,
    confirmed: z.literal(true),
    target_type: z.literal('medication'),
    draft: MedicationBatchRow,
  }).strict(),
  z.object({
    client_operation_id: Uuid,
    confirmed: z.literal(true),
    target_type: z.literal('observation'),
    defaults: ObservationBatchDefaults.default({}),
    draft: ObservationBatchRow,
  }).strict(),
]);

export const ContextAnswerPromoteResponse = z.discriminatedUnion('target_type', [
  z.object({
    source_answer_id: Uuid,
    target_type: z.literal('medication'),
    medication: Medication,
    warnings: z.array(MedicationWarning),
  }).strict(),
  z.object({
    source_answer_id: Uuid,
    target_type: z.literal('observation'),
    observation: Observation,
    warnings: z.array(ObservationWarning),
  }).strict(),
]);

export const ContextMediaSidecar = z.object({
  schema_version: z.literal('1.0'),
  upload_id: Uuid,
  person_id: Uuid,
  person_slug: z.string().regex(/^p[23456789a-hj-km-np-tv-z]{5}$/),
  session_id: Uuid,
  question_key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  question_text: z.string().min(1).max(500),
  template_id: z.string().min(2).max(64),
  template_version: z.number().int().min(1),
  template_hash: Sha256Hex,
  kind: ContextMediaKind,
  mime: ContextMediaMime,
  byte_size: z.number().int().positive(),
  sha256: Sha256Hex,
  object_key: z.string().min(1).max(1024),
  created_by: Uuid,
  created_at: IsoDateTime,
  finalized_at: IsoDateTime,
}).strict();

export type ContextQuestionT = z.infer<typeof ContextQuestion>;
export type ContextStageT = z.infer<typeof ContextStage>;
export type ContextTemplateDefinitionT = z.infer<typeof ContextTemplateDefinition>;
export type ContextTemplateSnapshotT = z.infer<typeof ContextTemplateSnapshot>;
export type ContextSessionCreateT = z.infer<typeof ContextSessionCreate>;
export type ContextSessionT = z.infer<typeof ContextSession>;
export type ContextAnswerInputT = z.infer<typeof ContextAnswerInput>;
export type ContextAnswersUpsertRequestT = z.infer<typeof ContextAnswersUpsertRequest>;
export type ContextAnswerT = z.infer<typeof ContextAnswer>;
export type ContextMediaMimeT = z.infer<typeof ContextMediaMime>;
export type ContextUploadPrepareRequestT = z.infer<typeof ContextUploadPrepareRequest>;
export type ContextUploadT = z.infer<typeof ContextUpload>;
export type ContextUploadSnapshotT = z.infer<typeof ContextUploadSnapshot>;
export type ContextAnswerPromoteRequestT = z.infer<typeof ContextAnswerPromoteRequest>;
export type ContextAnswerPromoteResponseT = z.infer<typeof ContextAnswerPromoteResponse>;
