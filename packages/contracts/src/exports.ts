import { z } from 'zod';
import { AccessRole } from './enums.js';
import { IsoDate, IsoDateTime, PersonSlug, Sha256Hex, Uuid } from './scalars.js';

export const PersonBundleRequest = z.object({ person_id: Uuid }).strict();

export const PersonBundleEntry = z.object({
  path: z.string().min(1),
  source_key: z.string().nullable(),
  byte_size: z.number().int().min(0),
  sha256: Sha256Hex,
}).strict();

export const PersonBundleGap = z.object({
  key: z.string(),
  reason: z.enum(['object_missing', 'manifest_missing', 'invalid_key', 'invalid_content']),
}).strict();

export const PersonBundleManifest = z.object({
  schema_version: z.literal('1.0'),
  person_id: Uuid,
  person_slug: PersonSlug,
  created_at: IsoDateTime,
  entries: z.array(PersonBundleEntry),
  gaps: z.array(PersonBundleGap),
  excludes: z.array(z.string()),
}).strict();

export type PersonBundleManifestT = z.infer<typeof PersonBundleManifest>;

export const ExportKind = z.literal('visit_summary');
export const ExportFormat = z.enum(['pdf', 'png']);
export const ExportState = z.enum(['pending', 'running', 'done', 'failed']);

const exportSelectionShape = {
  person_id: Uuid,
  metric_group_ids: z.array(Uuid).max(20).default([]),
  from: IsoDate.nullable().default(null),
  to: IsoDate.nullable().default(null),
  include_events: z.boolean().default(true),
  include_undated_events: z.boolean().default(true),
  include_originals: z.boolean().default(false),
  format: ExportFormat.default('pdf'),
};

function validateRange(value: { from: string | null; to: string | null }, ctx: z.RefinementCtx): void {
  if (value.from && value.to && value.to < value.from) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: '结束日期不得早于开始日期' });
  }
}

export const ExportSelection = z.object(exportSelectionShape).strict().superRefine(validateRange);
export const ExportPreviewRequest = ExportSelection;
export const VisitSummaryCreateRequest = z.object({
  client_operation_id: Uuid,
  ...exportSelectionShape,
}).strict().superRefine(validateRange);

export const ExportGap = z.object({
  code: z.enum([
    'no_metric_points', 'source_unavailable', 'original_missing', 'original_unsupported',
  ]),
  message: z.string().min(1).max(500),
  subject_type: z.enum(['metric_group', 'observation', 'medication', 'timeline_event', 'document']).nullable(),
  subject_id: Uuid.nullable(),
}).strict();

export const ExportMetricValue = z.object({
  observation_id: Uuid,
  observed_on: IsoDate,
  observed_at: IsoDateTime.nullable(),
  time_precision: z.enum(['date', 'minute', 'unknown']),
  value: z.string().min(1).max(500),
  reference: z.string().max(500).nullable(),
  abnormal_flag: z.string().max(100).nullable(),
  source_label: z.string().min(1).max(500),
  source_available: z.boolean(),
}).strict();

export const ExportMetricSummary = z.object({
  metric_group_id: Uuid,
  metric_group_name: z.string().min(1).max(200),
  group_item_id: Uuid,
  series_label: z.string().min(1).max(500),
  latest: ExportMetricValue,
  previous: ExportMetricValue.nullable(),
  change: z.string().max(500).nullable(),
}).strict();

export const ExportTimelineItem = z.object({
  source_type: z.enum(['encounter', 'medication', 'context_answer', 'timeline_event']),
  source_id: Uuid,
  label: z.string().min(1).max(1_000),
  occurred_on: IsoDate.nullable(),
  occurred_at: IsoDateTime.nullable(),
  time_precision: z.enum(['date', 'minute', 'unknown']),
  source_label: z.string().min(1).max(500),
  source_available: z.boolean(),
}).strict();

export const ExportOriginal = z.object({
  document_id: Uuid,
  page_id: Uuid,
  page_no: z.number().int().min(1),
  storage_key: z.string().min(1),
  content_sha256: Sha256Hex,
  byte_size: z.number().int().min(0),
  mime_type: z.string().min(1),
  available: z.boolean(),
}).strict();

export const ExportPreviewCounts = z.object({
  metric_groups: z.number().int().min(0),
  metric_series: z.number().int().min(0),
  observations: z.number().int().min(0),
  encounters: z.number().int().min(0),
  medications: z.number().int().min(0),
  context_events: z.number().int().min(0),
  timeline_events: z.number().int().min(0),
  undated_events: z.number().int().min(0),
  original_documents: z.number().int().min(0),
  original_pages: z.number().int().min(0),
}).strict();

export const ExportPreviewResponse = z.object({
  selection: ExportSelection,
  person: z.object({
    id: Uuid,
    display_name: z.string().min(1).max(64),
    birth_date: IsoDate,
    sex_at_birth: z.enum(['male', 'female', 'unknown']),
  }).strict(),
  counts: ExportPreviewCounts,
  metrics: z.array(ExportMetricSummary),
  events: z.array(ExportTimelineItem),
  gaps: z.array(ExportGap),
  originals: z.array(ExportOriginal),
  original_bytes_estimate: z.number().int().min(0),
  estimated_pages: z.number().int().min(1),
  source_revision_hash: Sha256Hex,
  can_generate: z.boolean(),
}).strict();

/** Frozen canonical input persisted on the job. It deliberately has no snapshot timestamp. */
export const ExportInputManifest = ExportPreviewResponse.omit({
  can_generate: true,
}).extend({
  schema_version: z.literal('1.0'),
  renderer_id: z.literal('medireco-visit-summary'),
  renderer_version: z.literal('1.0.0'),
  font_manifest_hash: Sha256Hex,
}).strict();

export const ExportJob = z.object({
  id: Uuid,
  person_id: Uuid,
  kind: ExportKind,
  request: ExportSelection,
  state: ExportState,
  attempt: z.number().int().min(0),
  max_attempts: z.number().int().min(1),
  progress: z.number().int().min(0).max(100),
  last_error: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
  renderer_id: z.string().min(1),
  renderer_version: z.string().min(1),
  font_manifest_hash: Sha256Hex,
  result_sha256: Sha256Hex.nullable(),
  result_byte_size: z.number().int().min(0).nullable(),
  result_content_hash: Sha256Hex.nullable(),
  artifact_available: z.boolean(),
  snapshot_at: IsoDateTime,
  source_revision_hash: Sha256Hex,
  stale: z.boolean(),
  created_by: Uuid,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  completed_at: IsoDateTime.nullable(),
}).strict();

export const ExportListQuery = z.object({
  person_id: Uuid,
  state: ExportState.optional(),
  kind: ExportKind.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();
export const ExportListResponse = z.object({
  access_role: AccessRole,
  exports: z.array(ExportJob),
  next_cursor: z.string().nullable(),
}).strict();
export const ExportRetryRequest = z.object({ client_operation_id: Uuid }).strict();

export const ExportShare = z.object({
  id: Uuid,
  export_job_id: Uuid,
  expires_at: IsoDateTime,
  created_by: Uuid,
  created_at: IsoDateTime,
  revoked_at: IsoDateTime.nullable(),
  last_accessed_at: IsoDateTime.nullable(),
  access_count: z.number().int().min(0),
}).strict();

export const ExportShareCreateRequest = z.object({
  client_operation_id: Uuid,
  expires_in_seconds: z.number().int().min(300).max(604_800),
  source_revision_hash: Sha256Hex,
  confirmed: z.literal(true),
}).strict();

export const ExportShareCreateResponse = z.object({
  share: ExportShare,
  /** 256-bit base64url secret, returned exactly once. */
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable(),
  token_recoverable: z.literal(false),
}).strict();

export const ExportShareListResponse = z.object({ shares: z.array(ExportShare) }).strict();
export const ExportShareRevokeRequest = z.object({ client_operation_id: Uuid }).strict();
export const PublicExportShareRequest = z.object({
  // Invalid/revoked/expired public secrets must all reach the same 404 path.
  token: z.string().min(1).max(256),
}).strict();

export type ExportSelectionT = z.infer<typeof ExportSelection>;
export type ExportPreviewRequestT = z.infer<typeof ExportPreviewRequest>;
export type ExportPreviewResponseT = z.infer<typeof ExportPreviewResponse>;
export type ExportInputManifestT = z.infer<typeof ExportInputManifest>;
export type VisitSummaryCreateRequestT = z.infer<typeof VisitSummaryCreateRequest>;
export type ExportJobT = z.infer<typeof ExportJob>;
export type ExportListQueryT = z.infer<typeof ExportListQuery>;
export type ExportListResponseT = z.infer<typeof ExportListResponse>;
export type ExportRetryRequestT = z.infer<typeof ExportRetryRequest>;
export type ExportShareT = z.infer<typeof ExportShare>;
export type ExportShareCreateRequestT = z.infer<typeof ExportShareCreateRequest>;
export type ExportShareCreateResponseT = z.infer<typeof ExportShareCreateResponse>;
export type ExportShareListResponseT = z.infer<typeof ExportShareListResponse>;
export type ExportShareRevokeRequestT = z.infer<typeof ExportShareRevokeRequest>;
