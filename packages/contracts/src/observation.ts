import { z } from 'zod';
import { IsoDate, IsoDateTime, Sha256Hex, Uuid } from './scalars.js';
import { ProcessingSuggestionProvenance, ProcessingSuggestionState } from './processing.js';

export const ObservationTimePrecision = z.enum(['date', 'minute', 'unknown']);
export const ObservationDateSource = z.enum(['manual', 'document_sampled', 'document_reported']);
export const ObservationComparator = z.enum(['<', '<=', '=', '>=', '>']);
export const ObservationResultKind = z.enum(['measured', 'calculated', 'input_parameter']);
export const ObservationSource = z.enum(['manual', 'imported', 'accepted_suggestion', 'derived']);
export const ObservationReviewStatus = z.enum(['confirmed', 'corrected']);
export const ObservationMappingStatus = z.enum(['mapped', 'unmapped']);
export const ObservationAbnormalFlag = z.enum([
  'low', 'high', 'critical_low', 'critical_high', 'abnormal', 'normal', 'unknown',
]);

const DimensionValue = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
export const ObservationDimensions = z.record(z.string().min(1).max(100), DimensionValue);
export const ObservationExtraDimensions = z.record(
  z.string().min(1).max(100), z.string().max(500),
);

export const ObservationSourceBbox = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict().superRefine((bbox, ctx) => {
  if (bbox.x + bbox.width > 1 + Number.EPSILON) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['width'], message: 'bbox 不得超出页面宽度' });
  }
  if (bbox.y + bbox.height > 1 + Number.EPSILON) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['height'], message: 'bbox 不得超出页面高度' });
  }
});

export const ObservationOriginPage = z.object({
  origin_capture_document_id: Uuid,
  origin_capture_order: z.number().int().min(1),
  object_sha256: Sha256Hex,
  logical_page_index: z.number().int().min(1),
  bbox: ObservationSourceBbox.nullable().default(null),
}).strict();

export const ObservationSourcePage = ObservationOriginPage.extend({
  current_document_id: Uuid.nullable(),
  current_page_no: z.number().int().min(1).nullable(),
  source_available: z.boolean(),
}).strict();

export const ObservationSeriesSelector = z.object({
  concept_code: z.string().min(1).max(100),
  qualifier: z.string().max(200).nullable(),
  body_site: z.string().max(200).nullable(),
  specimen: z.string().max(200).nullable(),
  method: z.string().max(300).nullable(),
  device: z.string().max(300).nullable(),
  measurement_setting: z.string().max(100).nullable(),
  extra_dims: ObservationExtraDimensions.nullable(),
  result_kind: ObservationResultKind,
  series_key: Sha256Hex,
}).strict();

const observationFactShape = {
  document_id: Uuid.nullable(),
  encounter_id: Uuid.nullable(),
  client_row_id: Uuid.nullable(),
  observed_on: IsoDate,
  observed_at: IsoDateTime.nullable(),
  time_precision: ObservationTimePrecision,
  date_source: ObservationDateSource,
  local_name: z.string().trim().min(1).max(300),
  concept_code: z.string().trim().min(1).max(100).nullable(),
  concept_catalog_version: z.string().trim().min(1).max(100).nullable(),
  loinc_code: z.string().trim().max(50).nullable(),
  qualifier: z.string().trim().max(200).nullable(),
  body_site: z.string().trim().max(200).nullable(),
  extra_dims: ObservationExtraDimensions.nullable(),
  series_key: Sha256Hex.nullable(),
  value_raw: z.string().trim().min(1).max(10_000),
  value_num: z.number().finite().nullable(),
  comparator: ObservationComparator.nullable(),
  value_text: z.string().max(10_000).nullable(),
  value_dimensions: ObservationDimensions.nullable(),
  unit_raw: z.string().trim().max(100).nullable(),
  unit_ucum: z.string().trim().max(100).nullable(),
  value_si: z.number().finite().nullable(),
  unit_si: z.string().trim().max(100).nullable(),
  conversion_version: z.string().trim().max(100).nullable(),
  ref_low: z.number().finite().nullable(),
  ref_high: z.number().finite().nullable(),
  ref_text: z.string().max(2_000).nullable(),
  ref_unit: z.string().trim().max(100).nullable(),
  abnormal_flag_raw: z.string().trim().max(100).nullable(),
  abnormal_flag: ObservationAbnormalFlag.nullable(),
  specimen: z.string().trim().max(200).nullable(),
  specimen_label: z.string().trim().max(200).nullable(),
  method: z.string().trim().max(300).nullable(),
  device: z.string().trim().max(300).nullable(),
  measurement_setting: z.string().trim().max(100).nullable(),
  result_kind: ObservationResultKind,
  collected_at: IsoDateTime.nullable(),
  reported_at: IsoDateTime.nullable(),
  lab_facility_id: Uuid.nullable(),
};

function validateObservationFact(
  value: {
    observed_at: string | null;
    time_precision: z.infer<typeof ObservationTimePrecision>;
    concept_code: string | null;
    concept_catalog_version: string | null;
    loinc_code: string | null;
    series_key: string | null;
    value_num: number | null;
    comparator: z.infer<typeof ObservationComparator> | null;
    value_text: string | null;
    value_dimensions: Record<string, unknown> | null;
    value_si: number | null;
    unit_si: string | null;
    conversion_version: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.time_precision === 'minute' && value.observed_at === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observed_at'], message: 'minute 精度必须提供 observed_at' });
  }
  if (value.time_precision !== 'minute' && value.observed_at !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observed_at'], message: '仅 minute 精度可保存 observed_at' });
  }
  if (value.concept_code === null) {
    for (const key of ['concept_catalog_version', 'loinc_code', 'series_key'] as const) {
      if (value[key] !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: '未映射 observation 不得声明概念派生字段' });
      }
    }
  } else if (value.concept_catalog_version === null || value.series_key === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['concept_catalog_version'], message: '已映射 observation 必须有 catalog version 与 series key' });
  }
  if (value.value_num === null && value.value_text === null && value.value_dimensions === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value_raw'], message: '必须保留至少一种结构化或文字结果' });
  }
  if (value.comparator !== null && value.value_num === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comparator'], message: '比较符只适用于数值结果' });
  }
  const conversionFields = [value.value_si, value.unit_si, value.conversion_version];
  const populated = conversionFields.filter((item) => item !== null).length;
  if (populated !== 0 && populated !== conversionFields.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value_si'], message: 'SI 换算值、单位和版本必须同时存在' });
  }
}

export const Observation = z.object({
  id: Uuid,
  person_id: Uuid,
  ...observationFactShape,
  mapping_status: ObservationMappingStatus,
  source_page: ObservationSourcePage.nullable(),
  source: ObservationSource,
  source_ref: z.record(z.unknown()).nullable(),
  review_status: ObservationReviewStatus,
  reviewed_by: Uuid.nullable(),
  reviewed_at: IsoDateTime.nullable(),
  consistency_flags: z.array(z.string().min(1).max(100)).max(100),
  is_derived: z.boolean(),
  derived_formula: z.string().max(500).nullable(),
  calculation_version: z.string().max(100).nullable(),
  derivation_key: Sha256Hex.nullable(),
  input_observation_ids: z.array(Uuid).nullable(),
  input_revision_hash: Sha256Hex.nullable(),
  revision: z.number().int().min(1),
  created_by: Uuid.nullable(),
  created_at: IsoDateTime,
  updated_by: Uuid.nullable(),
  updated_at: IsoDateTime,
  archived_at: IsoDateTime.nullable(),
}).strict().superRefine(validateObservationFact);

export const ObservationBatchDefaults = z.object({
  document_id: Uuid.nullable().default(null),
  encounter_id: Uuid.nullable().default(null),
  observed_on: IsoDate.optional(),
  observed_at: IsoDateTime.nullable().default(null),
  time_precision: ObservationTimePrecision.default('date'),
  date_source: ObservationDateSource.default('manual'),
  specimen: z.string().trim().max(200).nullable().default(null),
  specimen_label: z.string().trim().max(200).nullable().default(null),
  method: z.string().trim().max(300).nullable().default(null),
  device: z.string().trim().max(300).nullable().default(null),
  measurement_setting: z.string().trim().max(100).nullable().default(null),
  collected_at: IsoDateTime.nullable().default(null),
  reported_at: IsoDateTime.nullable().default(null),
  lab_facility_id: Uuid.nullable().default(null),
}).strict();

export const ObservationBatchRow = z.object({
  client_row_id: Uuid,
  document_id: Uuid.nullable().optional(),
  encounter_id: Uuid.nullable().optional(),
  observed_on: IsoDate.optional(),
  observed_at: IsoDateTime.nullable().optional(),
  time_precision: ObservationTimePrecision.optional(),
  date_source: ObservationDateSource.optional(),
  local_name: z.string().trim().min(1).max(300),
  concept_code: z.string().trim().min(1).max(100).nullable().default(null),
  concept_catalog_version: z.string().trim().min(1).max(100).nullable().default(null),
  loinc_code: z.string().trim().max(50).nullable().default(null),
  qualifier: z.string().trim().max(200).nullable().default(null),
  body_site: z.string().trim().max(200).nullable().default(null),
  extra_dims: ObservationExtraDimensions.nullable().default(null),
  value_raw: z.string().trim().min(1).max(10_000),
  value_num: z.number().finite().nullable().default(null),
  comparator: ObservationComparator.nullable().default(null),
  value_text: z.string().max(10_000).nullable().default(null),
  value_dimensions: ObservationDimensions.nullable().default(null),
  unit_raw: z.string().trim().max(100).nullable().default(null),
  unit_ucum: z.string().trim().max(100).nullable().default(null),
  ref_low: z.number().finite().nullable().default(null),
  ref_high: z.number().finite().nullable().default(null),
  ref_text: z.string().max(2_000).nullable().default(null),
  ref_unit: z.string().trim().max(100).nullable().default(null),
  abnormal_flag_raw: z.string().trim().max(100).nullable().default(null),
  abnormal_flag: ObservationAbnormalFlag.nullable().default(null),
  specimen: z.string().trim().max(200).nullable().optional(),
  specimen_label: z.string().trim().max(200).nullable().optional(),
  method: z.string().trim().max(300).nullable().optional(),
  device: z.string().trim().max(300).nullable().optional(),
  measurement_setting: z.string().trim().max(100).nullable().optional(),
  result_kind: ObservationResultKind.default('measured'),
  collected_at: IsoDateTime.nullable().optional(),
  reported_at: IsoDateTime.nullable().optional(),
  lab_facility_id: Uuid.nullable().optional(),
  source_page: ObservationOriginPage.nullable().default(null),
}).strict();

export const ObservationBatchCreateRequest = z.object({
  client_operation_id: Uuid,
  defaults: ObservationBatchDefaults.default({}),
  observations: z.array(ObservationBatchRow).min(1).max(100),
}).strict().superRefine((request, ctx) => {
  if (new Set(request.observations.map((row) => row.client_row_id)).size !== request.observations.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observations'], message: 'client_row_id 不得重复' });
  }
  request.observations.forEach((row, index) => {
    const observedOn = row.observed_on ?? request.defaults.observed_on;
    const observedAt = row.observed_at === undefined ? request.defaults.observed_at : row.observed_at;
    const precision = row.time_precision ?? request.defaults.time_precision;
    if (!observedOn) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observations', index, 'observed_on'], message: 'observed_on 必填或由 defaults 提供' });
    }
    if (precision === 'minute' && observedAt === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observations', index, 'observed_at'], message: 'minute 精度必须提供 observed_at' });
    }
    if (precision !== 'minute' && observedAt !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observations', index, 'observed_at'], message: '仅 minute 精度可保存 observed_at' });
    }
    if (row.concept_code === null && row.concept_catalog_version !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observations', index, 'concept_catalog_version'], message: '未映射行不得声明 catalog version' });
    }
    if (row.concept_code !== null && row.concept_catalog_version === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observations', index, 'concept_catalog_version'], message: '已映射行必须声明 catalog version' });
    }
    // value_raw 是不可丢的输入；数值/比较符或文字结构由 Core
    // 确定性解析。客户端可显式传入复核结果，但不应成为必填前置。
    if (row.comparator !== null && row.value_num === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observations', index, 'comparator'], message: '比较符只适用于数值结果' });
    }
  });
});

export const ObservationWarning = z.object({
  row_index: z.number().int().min(0),
  client_row_id: Uuid,
  code: z.enum(['unknown_unit', 'unmapped_concept', 'source_unavailable']),
  message: z.string(),
}).strict();

export const ObservationBatchCreateResponse = z.object({
  observations: z.array(Observation),
  warnings: z.array(ObservationWarning),
}).strict();

// Plugin 只提供可审核草稿，不能指定 L1 client_row_id。接受时由客户端
// 给每个所选行分配稳定 ID，并可逐字段 override。
export const ObservationSuggestionDraft = ObservationBatchRow.omit({ client_row_id: true });
export const ObservationSuggestionRow = z.object({
  row_id: z.string().min(1).max(200),
  draft: ObservationSuggestionDraft,
}).strict();
export const ObservationSuggestionPayload = z.object({
  defaults: ObservationBatchDefaults.default({}),
  rows: z.array(ObservationSuggestionRow).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.rows.map((row) => row.row_id)).size !== value.rows.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rows'], message: 'suggestion row_id 不得重复' });
  }
});
export const ObservationSuggestion = z.object({
  id: Uuid,
  document_id: Uuid,
  person_id: Uuid,
  input_revision: z.number().int().min(0),
  input_sha256: Sha256Hex,
  payload: ObservationSuggestionPayload,
  provenance: ProcessingSuggestionProvenance,
  state: ProcessingSuggestionState,
  accepted_row_ids: z.array(z.string()),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
}).strict();
export const ObservationSuggestionListResponse = z.object({
  suggestions: z.array(ObservationSuggestion),
}).strict();
export const ObservationSuggestionAcceptRow = z.object({
  suggestion_row_id: z.string().min(1).max(200),
  client_row_id: Uuid,
  overrides: ObservationSuggestionDraft.partial().default({}),
}).strict();
export const ObservationSuggestionAcceptRequest = z.object({
  client_operation_id: Uuid,
  if_input_revision: z.number().int().min(0),
  rows: z.array(ObservationSuggestionAcceptRow).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.rows.map((row) => row.suggestion_row_id)).size !== value.rows.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rows'], message: '不得重复接受同一 suggestion row' });
  }
  if (new Set(value.rows.map((row) => row.client_row_id)).size !== value.rows.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rows'], message: 'client_row_id 不得重复' });
  }
});
export const ObservationSuggestionAcceptResponse = ObservationBatchCreateResponse.extend({
  suggestion_id: Uuid,
  accepted_row_ids: z.array(z.string()),
}).strict();

const observationPatchShape = {
  document_id: Uuid.nullable().optional(),
  encounter_id: Uuid.nullable().optional(),
  observed_on: IsoDate.optional(),
  observed_at: IsoDateTime.nullable().optional(),
  time_precision: ObservationTimePrecision.optional(),
  date_source: ObservationDateSource.optional(),
  local_name: z.string().trim().min(1).max(300).optional(),
  concept_code: z.string().trim().min(1).max(100).nullable().optional(),
  concept_catalog_version: z.string().trim().min(1).max(100).nullable().optional(),
  qualifier: z.string().trim().max(200).nullable().optional(),
  body_site: z.string().trim().max(200).nullable().optional(),
  extra_dims: ObservationExtraDimensions.nullable().optional(),
  value_raw: z.string().trim().min(1).max(10_000).optional(),
  value_num: z.number().finite().nullable().optional(),
  comparator: ObservationComparator.nullable().optional(),
  value_text: z.string().max(10_000).nullable().optional(),
  value_dimensions: ObservationDimensions.nullable().optional(),
  unit_raw: z.string().trim().max(100).nullable().optional(),
  unit_ucum: z.string().trim().max(100).nullable().optional(),
  ref_low: z.number().finite().nullable().optional(),
  ref_high: z.number().finite().nullable().optional(),
  ref_text: z.string().max(2_000).nullable().optional(),
  ref_unit: z.string().trim().max(100).nullable().optional(),
  abnormal_flag_raw: z.string().trim().max(100).nullable().optional(),
  abnormal_flag: ObservationAbnormalFlag.nullable().optional(),
  specimen: z.string().trim().max(200).nullable().optional(),
  specimen_label: z.string().trim().max(200).nullable().optional(),
  method: z.string().trim().max(300).nullable().optional(),
  device: z.string().trim().max(300).nullable().optional(),
  measurement_setting: z.string().trim().max(100).nullable().optional(),
  result_kind: ObservationResultKind.optional(),
  collected_at: IsoDateTime.nullable().optional(),
  reported_at: IsoDateTime.nullable().optional(),
  lab_facility_id: Uuid.nullable().optional(),
  source_page: ObservationOriginPage.nullable().optional(),
};

export const ObservationPatchRequest = z.object({
  client_operation_id: Uuid,
  if_revision: z.number().int().min(1),
  correction_note: z.string().trim().min(1).max(2_000),
  ...observationPatchShape,
}).strict().superRefine((request, ctx) => {
  if (!Object.keys(observationPatchShape).some((key) => Object.prototype.hasOwnProperty.call(request, key))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少提交一个 observation 修正字段' });
  }
});

export const ObservationArchiveRequest = z.object({
  client_operation_id: Uuid,
  if_revision: z.number().int().min(1),
  correction_note: z.string().trim().min(1).max(2_000),
}).strict();

export const ObservationListQuery = z.object({
  person_id: Uuid,
  concept_code: z.string().trim().max(100).optional(),
  local_name: z.string().trim().max(300).optional(),
  mapping_status: ObservationMappingStatus.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  source: ObservationSource.optional(),
  review_status: ObservationReviewStatus.optional(),
  document_id: Uuid.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

export const ObservationListResponse = z.object({
  observations: z.array(Observation),
  next_cursor: z.string().nullable(),
}).strict();

export const MedicalConcept = z.object({
  code: z.string(),
  display_name: z.string(),
  aliases: z.array(z.string()),
  kind: z.enum(['laboratory', 'vital', 'anthropometric', 'derived']),
  loinc_code: z.string().nullable(),
  canonical_unit: z.string(),
  catalog_version: z.string(),
}).strict();

export const MedicalConceptQuery = z.object({
  q: z.string().trim().max(200).default(''),
  kind: MedicalConcept.shape.kind.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export const MedicalConceptListResponse = z.object({ concepts: z.array(MedicalConcept) }).strict();

export const ConceptAliasContext = z.object({
  specimen: z.string().max(200).nullable(),
  method: z.string().max(300).nullable(),
}).strict();

export const ConceptAliasDecision = z.object({
  id: Uuid,
  person_id: Uuid,
  input_fingerprint: Sha256Hex,
  local_name: z.string(),
  context: ConceptAliasContext,
  concept_code: z.string(),
  display_name: z.string(),
  catalog_version: z.string(),
  state: z.enum(['confirmed', 'superseded']),
  revision: z.number().int().min(1),
  decided_by: Uuid,
  decided_at: IsoDateTime,
  updated_at: IsoDateTime,
}).strict();

export const ConceptAliasUpsertRequest = z.object({
  client_operation_id: Uuid,
  local_name: z.string().trim().min(1).max(300),
  context: ConceptAliasContext.default({ specimen: null, method: null }),
  concept_code: z.string().min(1).max(100),
  catalog_version: z.string().min(1).max(100),
}).strict();

export const ConceptAliasPatchRequest = z.object({
  client_operation_id: Uuid,
  if_revision: z.number().int().min(1),
  concept_code: z.string().min(1).max(100),
  catalog_version: z.string().min(1).max(100),
}).strict();

export const ObservationMappingInboxQuery = z.object({
  person_id: Uuid,
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

export const ObservationMappingInboxResponse = z.object({
  items: z.array(z.object({
    input_fingerprint: Sha256Hex,
    local_name: z.string(),
    context: ConceptAliasContext,
    count: z.number().int().min(1),
    first_observed_on: IsoDate,
    latest_observed_on: IsoDate,
    observation_ids: z.array(Uuid),
  }).strict()),
  next_cursor: z.string().nullable(),
}).strict();

export const ObservationMappingResolveRequest = z.object({
  client_operation_id: Uuid,
  mode: z.enum(['selected', 'same_fingerprint']),
  input_fingerprint: Sha256Hex,
  local_name: z.string().trim().min(1).max(300),
  context: ConceptAliasContext,
  concept_code: z.string().min(1).max(100),
  catalog_version: z.string().min(1).max(100),
  rows: z.array(z.object({
    observation_id: Uuid,
    if_revision: z.number().int().min(1),
  }).strict()).min(1).max(100),
}).strict();

export const ObservationMappingResolveResponse = z.object({
  alias: ConceptAliasDecision,
  observations: z.array(Observation),
  series_selectors: z.array(ObservationSeriesSelector),
}).strict();

export type ObservationT = z.infer<typeof Observation>;
export type MedicalConceptT = z.infer<typeof MedicalConcept>;
export type MedicalConceptListResponseT = z.infer<typeof MedicalConceptListResponse>;
export type ObservationMappingInboxResponseT = z.infer<typeof ObservationMappingInboxResponse>;
export type ObservationSuggestionT = z.infer<typeof ObservationSuggestion>;
export type ObservationBatchRowT = z.infer<typeof ObservationBatchRow>;
export type ObservationBatchCreateRequestT = z.infer<typeof ObservationBatchCreateRequest>;
export type ObservationBatchCreateResponseT = z.infer<typeof ObservationBatchCreateResponse>;
export type ObservationSuggestionPayloadT = z.infer<typeof ObservationSuggestionPayload>;
export type ObservationSuggestionAcceptRequestT = z.infer<typeof ObservationSuggestionAcceptRequest>;
export type ObservationPatchRequestT = z.infer<typeof ObservationPatchRequest>;
export type ObservationArchiveRequestT = z.infer<typeof ObservationArchiveRequest>;
export type ObservationListQueryT = z.infer<typeof ObservationListQuery>;
export type ObservationSourcePageT = z.infer<typeof ObservationSourcePage>;
export type ObservationOriginPageT = z.infer<typeof ObservationOriginPage>;
export type ConceptAliasDecisionT = z.infer<typeof ConceptAliasDecision>;
export type ObservationMappingResolveRequestT = z.infer<typeof ObservationMappingResolveRequest>;
