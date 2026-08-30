import { z } from 'zod';
import { IsoDate, IsoDateTime, Uuid } from './scalars.js';
import { ObservationOriginPage, ObservationSourcePage } from './observation.js';

export const MedicationKind = z.enum(['prescribed', 'administered']);
export const MedicationSource = z.enum(['manual', 'imported', 'accepted_suggestion']);
export const TimelineEventKind = z.enum([
  'procedure', 'hospitalization', 'symptom', 'change', 'other',
]);
export const ClinicalTimePrecision = z.enum(['date', 'minute', 'unknown']);

const nullableText = (max: number) => z.string().trim().max(max).nullable();
const nullableNonNegative = z.number().finite().nonnegative().nullable();

const medicationFactShape = {
  encounter_id: Uuid.nullable(),
  kind: MedicationKind,
  name_raw: z.string().trim().min(1).max(500),
  generic_name: nullableText(500),
  dose_raw: nullableText(500),
  dose_value: nullableNonNegative,
  dose_unit: nullableText(100),
  concentration_pct: z.number().finite().min(0).max(100).nullable(),
  solute_mass_g: nullableNonNegative,
  frequency_raw: nullableText(500),
  route: nullableText(200),
  administration_group: nullableText(200),
  group_volume_ml: nullableNonNegative,
  sequence: z.number().int().min(1).nullable(),
  administered_at: IsoDateTime.nullable(),
  started_on: IsoDate.nullable(),
  ended_on: IsoDate.nullable(),
  source_page: ObservationOriginPage.nullable(),
  note: nullableText(10_000),
};

function validateMedicationFact(
  value: {
    kind: z.infer<typeof MedicationKind>;
    administered_at: string | null;
    started_on: string | null;
    ended_on: string | null;
    dose_value: number | null;
    dose_unit: string | null;
    sequence: number | null;
    administration_group: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.kind === 'administered' && value.administered_at === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['administered_at'], message: '已执行用药必须填写执行时间' });
  }
  if (value.kind === 'prescribed' && value.started_on === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['started_on'], message: '处方用药必须填写开始日期' });
  }
  if (value.started_on !== null && value.ended_on !== null && value.ended_on < value.started_on) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ended_on'], message: '结束日期不得早于开始日期' });
  }
  if ((value.dose_value === null) !== (value.dose_unit === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dose_unit'], message: '结构化剂量值和单位必须同时存在' });
  }
  if (value.sequence !== null && value.administration_group === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['administration_group'], message: '执行顺序必须属于一个给药分组' });
  }
}

export const MedicationBatchRow = z.object({
  client_row_id: Uuid,
  ...medicationFactShape,
}).strict().superRefine(validateMedicationFact);

export const MedicationBatchCreateRequest = z.object({
  client_operation_id: Uuid,
  medications: z.array(MedicationBatchRow).min(1).max(100),
}).strict().superRefine((request, ctx) => {
  if (new Set(request.medications.map((row) => row.client_row_id)).size !== request.medications.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['medications'], message: 'client_row_id 不得重复' });
  }
});

export const Medication = z.object({
  id: Uuid,
  person_id: Uuid,
  client_row_id: Uuid,
  ...medicationFactShape,
  source_page: ObservationSourcePage.nullable(),
  canonical_on: IsoDate,
  canonical_at: IsoDateTime.nullable(),
  time_precision: z.enum(['date', 'minute']),
  source: MedicationSource,
  source_ref: z.record(z.unknown()).nullable(),
  revision: z.number().int().min(1),
  created_by: Uuid,
  created_at: IsoDateTime,
  updated_by: Uuid,
  updated_at: IsoDateTime,
  archived_at: IsoDateTime.nullable(),
}).strict().superRefine(validateMedicationFact);

export const MedicationWarning = z.object({
  row_index: z.number().int().min(0),
  client_row_id: Uuid,
  code: z.literal('source_unavailable'),
  message: z.string(),
}).strict();

export const MedicationBatchCreateResponse = z.object({
  medications: z.array(Medication),
  warnings: z.array(MedicationWarning),
}).strict();

const medicationPatchShape = {
  encounter_id: medicationFactShape.encounter_id.optional(),
  kind: MedicationKind.optional(),
  name_raw: medicationFactShape.name_raw.optional(),
  generic_name: medicationFactShape.generic_name.optional(),
  dose_raw: medicationFactShape.dose_raw.optional(),
  dose_value: medicationFactShape.dose_value.optional(),
  dose_unit: medicationFactShape.dose_unit.optional(),
  concentration_pct: medicationFactShape.concentration_pct.optional(),
  solute_mass_g: medicationFactShape.solute_mass_g.optional(),
  frequency_raw: medicationFactShape.frequency_raw.optional(),
  route: medicationFactShape.route.optional(),
  administration_group: medicationFactShape.administration_group.optional(),
  group_volume_ml: medicationFactShape.group_volume_ml.optional(),
  sequence: medicationFactShape.sequence.optional(),
  administered_at: medicationFactShape.administered_at.optional(),
  started_on: medicationFactShape.started_on.optional(),
  ended_on: medicationFactShape.ended_on.optional(),
  source_page: medicationFactShape.source_page.optional(),
  note: medicationFactShape.note.optional(),
};

export const MedicationPatchRequest = z.object({
  client_operation_id: Uuid,
  if_revision: z.number().int().min(1),
  correction_note: z.string().trim().min(1).max(2_000),
  ...medicationPatchShape,
}).strict().superRefine((request, ctx) => {
  if (!Object.keys(medicationPatchShape).some((key) => Object.prototype.hasOwnProperty.call(request, key))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少提交一个用药修正字段' });
  }
});

export const MedicationArchiveRequest = z.object({
  client_operation_id: Uuid,
  if_revision: z.number().int().min(1),
  correction_note: z.string().trim().min(1).max(2_000),
}).strict();

export const MedicationListQuery = z.object({
  person_id: Uuid,
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  kind: MedicationKind.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

export const MedicationListResponse = z.object({
  medications: z.array(Medication),
  next_cursor: z.string().nullable(),
}).strict();

const timelineFactShape = {
  encounter_id: Uuid.nullable(),
  kind: TimelineEventKind,
  title: z.string().trim().min(1).max(500),
  occurred_on: IsoDate.nullable(),
  occurred_at: IsoDateTime.nullable(),
  time_precision: ClinicalTimePrecision,
  note: nullableText(10_000),
  source_page: ObservationOriginPage.nullable(),
};

function validateTimelineFact(
  value: { occurred_on: string | null; occurred_at: string | null; time_precision: z.infer<typeof ClinicalTimePrecision> },
  ctx: z.RefinementCtx,
): void {
  if (value.time_precision === 'minute' && (value.occurred_on === null || value.occurred_at === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['occurred_at'], message: 'minute 精度必须同时提供日期和时刻' });
  }
  if (value.time_precision === 'date' && (value.occurred_on === null || value.occurred_at !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['occurred_on'], message: 'date 精度只保存日期，不伪造时刻' });
  }
  if (value.time_precision === 'unknown' && (value.occurred_on !== null || value.occurred_at !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['occurred_on'], message: 'unknown 精度属于“日期未记录”，不得保存伪造日期' });
  }
}

export const TimelineEventCreateRequest = z.object({
  client_operation_id: Uuid,
  ...timelineFactShape,
}).strict().superRefine(validateTimelineFact);

export const TimelineEvent = z.object({
  id: Uuid,
  person_id: Uuid,
  ...timelineFactShape,
  source_page: ObservationSourcePage.nullable(),
  source: MedicationSource,
  source_ref: z.record(z.unknown()).nullable(),
  revision: z.number().int().min(1),
  created_by: Uuid,
  created_at: IsoDateTime,
  updated_by: Uuid,
  updated_at: IsoDateTime,
  archived_at: IsoDateTime.nullable(),
}).strict().superRefine(validateTimelineFact);

const timelinePatchShape = {
  encounter_id: timelineFactShape.encounter_id.optional(),
  kind: TimelineEventKind.optional(),
  title: timelineFactShape.title.optional(),
  occurred_on: timelineFactShape.occurred_on.optional(),
  occurred_at: timelineFactShape.occurred_at.optional(),
  time_precision: timelineFactShape.time_precision.optional(),
  note: timelineFactShape.note.optional(),
  source_page: timelineFactShape.source_page.optional(),
};

export const TimelineEventPatchRequest = z.object({
  client_operation_id: Uuid,
  if_revision: z.number().int().min(1),
  correction_note: z.string().trim().min(1).max(2_000),
  ...timelinePatchShape,
}).strict().superRefine((request, ctx) => {
  if (!Object.keys(timelinePatchShape).some((key) => Object.prototype.hasOwnProperty.call(request, key))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少提交一个时间轴修正字段' });
  }
});

export const TimelineEventArchiveRequest = MedicationArchiveRequest;

export const TimelineEventListQuery = z.object({
  person_id: Uuid,
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  kind: TimelineEventKind.optional(),
  include_undated: z.union([
    z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true'),
  ]).default(true),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

export const TimelineEventListResponse = z.object({
  events: z.array(TimelineEvent),
  next_cursor: z.string().nullable(),
}).strict();

export type MedicationT = z.infer<typeof Medication>;
export type MedicationBatchRowT = z.infer<typeof MedicationBatchRow>;
export type MedicationBatchCreateRequestT = z.infer<typeof MedicationBatchCreateRequest>;
export type MedicationBatchCreateResponseT = z.infer<typeof MedicationBatchCreateResponse>;
export type MedicationPatchRequestT = z.infer<typeof MedicationPatchRequest>;
export type MedicationArchiveRequestT = z.infer<typeof MedicationArchiveRequest>;
export type MedicationListQueryT = z.infer<typeof MedicationListQuery>;
export type TimelineEventT = z.infer<typeof TimelineEvent>;
export type TimelineEventCreateRequestT = z.infer<typeof TimelineEventCreateRequest>;
export type TimelineEventPatchRequestT = z.infer<typeof TimelineEventPatchRequest>;
export type TimelineEventArchiveRequestT = z.infer<typeof TimelineEventArchiveRequest>;
export type TimelineEventListQueryT = z.infer<typeof TimelineEventListQuery>;
