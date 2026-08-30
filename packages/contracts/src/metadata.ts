import { z } from 'zod';
import { DocType } from './enums.js';
import { IsoDate, IsoDateTime, Uuid } from './scalars.js';
import { ProcessingSuggestionProvenance, ProcessingSuggestionState } from './processing.js';

export const ManualMetadataField = z.enum([
  'doc_type', 'sampled_on', 'reported_on', 'facility_id',
  'facility_name_raw', 'department', 'title', 'note',
]);
export const MetadataProvenanceSource = z.enum(['manual', 'accepted_suggestion']);
export const EffectiveMetadataSource = z.enum([
  'manual', 'accepted_suggestion', 'capture_fallback',
]);

export const MetadataFieldProvenance = z.object({
  source: MetadataProvenanceSource,
  event_id: Uuid,
  suggestion_id: Uuid.nullable().optional(),
}).strict();

export const MetadataFieldProvenanceMap = z.record(ManualMetadataField, MetadataFieldProvenance);

export const DocumentMetadataPatch = z.object({
  client_operation_id: Uuid,
  if_revision: z.number().int().min(0),
  doc_type: DocType.nullable().optional(),
  sampled_on: IsoDate.nullable().optional(),
  reported_on: IsoDate.nullable().optional(),
  facility_id: Uuid.nullable().optional(),
  facility_name_raw: z.string().trim().max(300).nullable().optional(),
  department: z.string().trim().max(200).nullable().optional(),
  title: z.string().trim().max(300).nullable().optional(),
  note: z.string().trim().max(4000).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (!ManualMetadataField.options.some((field) => Object.prototype.hasOwnProperty.call(value, field))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少提交一个元数据字段' });
  }
});

const effectiveField = <T extends z.ZodTypeAny>(value: T) => z.object({
  value: value.nullable(),
  source: EffectiveMetadataSource,
  suggestion_id: Uuid.nullable(),
}).strict();

export const EffectiveDocumentMetadata = z.object({
  doc_type: effectiveField(DocType),
  sampled_on: effectiveField(IsoDate),
  reported_on: effectiveField(IsoDate),
  facility_name: effectiveField(z.string()),
  department: effectiveField(z.string()),
  title: effectiveField(z.string()),
  note: effectiveField(z.string()),
}).strict();

export const DocumentManualMetadataSnapshot = z.object({
  document_id: Uuid,
  doc_type: DocType.nullable(),
  sampled_on: IsoDate.nullable(),
  reported_on: IsoDate.nullable(),
  facility_id: Uuid.nullable(),
  facility_name_raw: z.string().nullable(),
  department: z.string().nullable(),
  title: z.string().nullable(),
  note: z.string().nullable(),
  field_provenance: MetadataFieldProvenanceMap,
  revision: z.number().int().min(1),
  updated_by: Uuid,
  updated_at: IsoDateTime,
}).strict();

export const DocumentMetadataMutationResponse = z.object({
  document_id: Uuid,
  revision: z.number().int().min(1),
  effective_metadata: EffectiveDocumentMetadata,
  field_provenance: MetadataFieldProvenanceMap,
}).strict();

export const MetadataSuggestionValues = z.object({
  doc_type: DocType.nullable().optional(),
  sampled_on: IsoDate.nullable().optional(),
  reported_on: IsoDate.nullable().optional(),
  facility_name_raw: z.string().max(300).nullable().optional(),
  department: z.string().max(200).nullable().optional(),
  title: z.string().max(300).nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
}).strict();

export const MetadataSuggestion = z.object({
  id: Uuid,
  document_id: Uuid,
  input_revision: z.number().int().min(0),
  values: MetadataSuggestionValues,
  provenance: ProcessingSuggestionProvenance,
  state: ProcessingSuggestionState,
  accepted_fields: z.array(ManualMetadataField),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
}).strict();

export const MetadataSuggestionListResponse = z.object({
  suggestions: z.array(MetadataSuggestion),
}).strict();

export const MetadataSuggestionAcceptRequest = z.object({
  client_operation_id: Uuid,
  if_revision: z.number().int().min(0),
  fields: z.array(ManualMetadataField).min(1).refine(
    (fields) => new Set(fields).size === fields.length,
    'fields 不得重复',
  ),
  overrides: MetadataSuggestionValues.default({}),
}).strict();

export const MetadataSuggestionAcceptResponse = DocumentMetadataMutationResponse.extend({
  suggestion_id: Uuid,
  before: z.record(ManualMetadataField, z.unknown()),
  after: z.record(ManualMetadataField, z.unknown()),
}).strict();

export const MetadataMigrationInboxQuery = z.object({
  person_id: Uuid,
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

export const MetadataMigrationInboxResponse = z.object({
  items: z.array(z.object({
    document_id: Uuid,
    current_revision: z.number().int().min(0),
    effective_metadata: EffectiveDocumentMetadata,
    suggestion: MetadataSuggestion,
  }).strict()),
  next_cursor: z.string().nullable(),
}).strict();

export const MetadataMigrationBatchAcceptRequest = z.object({
  items: z.array(z.object({
    document_id: Uuid,
    suggestion_id: Uuid,
    client_operation_id: Uuid,
    if_revision: z.number().int().min(0),
    fields: z.array(ManualMetadataField).min(1).refine(
      (fields) => new Set(fields).size === fields.length,
      'fields 不得重复',
    ),
    overrides: MetadataSuggestionValues.default({}),
  }).strict()).min(1).max(50),
}).strict();

export const MetadataMigrationBatchAcceptResponse = z.object({
  results: z.array(z.object({
    document_id: Uuid,
    ok: z.boolean(),
    result: MetadataSuggestionAcceptResponse.nullable(),
    error: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
  }).strict()),
}).strict();

export const FacilityListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

export const FacilityListResponse = z.object({
  facilities: z.array(z.object({
    id: Uuid,
    name: z.string(),
    slug: z.string(),
    city: z.string().nullable(),
    level: z.string().nullable(),
  }).strict()),
}).strict();

export type DocumentMetadataPatchT = z.infer<typeof DocumentMetadataPatch>;
export type EffectiveDocumentMetadataT = z.infer<typeof EffectiveDocumentMetadata>;
export type DocumentManualMetadataSnapshotT = z.infer<typeof DocumentManualMetadataSnapshot>;
export type DocumentMetadataMutationResponseT = z.infer<typeof DocumentMetadataMutationResponse>;
export type ManualMetadataFieldT = z.infer<typeof ManualMetadataField>;
export type MetadataSuggestionT = z.infer<typeof MetadataSuggestion>;
export type MetadataSuggestionAcceptRequestT = z.infer<typeof MetadataSuggestionAcceptRequest>;
export type MetadataSuggestionAcceptResponseT = z.infer<typeof MetadataSuggestionAcceptResponse>;
export type MetadataMigrationInboxResponseT = z.infer<typeof MetadataMigrationInboxResponse>;
export type MetadataMigrationBatchAcceptRequestT = z.infer<typeof MetadataMigrationBatchAcceptRequest>;
export type FacilityListResponseT = z.infer<typeof FacilityListResponse>;
