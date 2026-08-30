import {
  AccountProfile, ArchiveResponse, CapabilitiesResponse, CorrectionResponse, DeleteAccountResponse,
  DocumentDetailResponse, DocumentListResponse, DocumentMetadataMutationResponse, DocumentOut,
  Encounter, EncounterDocumentsSetResponse, EncounterListResponse, FacilityListResponse, LoginResponse,
  MetadataMigrationBatchAcceptResponse, MetadataMigrationInboxResponse,
  MetadataSuggestionAcceptResponse, MetadataSuggestionListResponse, SearchResponse,
  MultipartCompleteResponse, MultipartCreateResponse, MultipartSignResponse,
  NormalizationConfirmResponse, NormalizationDecisionListResponse, PersonListResponse, PresignResponse,
  Person as PersonResponse, PersonCheckAckResponse,
  ContextPendingResponse, ContextSessionDetailResponse, ContextSessionMutationResponse,
  ContextTemplateManifestResponse, ContextTemplateSnapshot,
  ContextUploadFinalizeResponse, ContextUploadPrepareResponse,
  ContextUploadPresignResponse, ContextUploadViewResponse,
  MedicalConceptListResponse, Observation, ObservationBatchCreateResponse,
  ObservationListResponse, ObservationMappingInboxResponse, ObservationMappingResolveResponse,
  ObservationSuggestionAcceptResponse, ObservationSuggestionListResponse,
  MetricGroup, MetricGroupListResponse, TrendResponse,
  Medication, MedicationBatchCreateResponse, MedicationListResponse,
  TimelineEvent, TimelineEventListResponse,
  ExportJob, ExportListResponse, ExportPreviewResponse, ExportShare,
  ExportShareCreateResponse, ExportShareListResponse,
  type CaptureDiscardRequestT, type DocumentListQueryT, type DocumentMetadataPatchT,
  type EncounterCreateT, type EncounterDocumentsSetT, type EncounterPatchT,
  type ContextAnswersUpsertRequestT, type ContextSessionCreateT,
  type ContextUploadPrepareRequestT,
  type ObservationArchiveRequestT, type ObservationBatchCreateRequestT,
  type ObservationListQueryT, type ObservationMappingResolveRequestT,
  type ObservationPatchRequestT, type ObservationSuggestionAcceptRequestT,
  type MetricGroupArchiveRequestT, type MetricGroupCreateRequestT,
  type MetricGroupPatchRequestT,
  type MedicationArchiveRequestT, type MedicationBatchCreateRequestT,
  type MedicationListQueryT, type MedicationPatchRequestT,
  type TimelineEventArchiveRequestT, type TimelineEventCreateRequestT,
  type TimelineEventListQueryT, type TimelineEventPatchRequestT,
  type ExportListQueryT, type ExportPreviewRequestT, type ExportRetryRequestT,
  type ExportShareCreateRequestT, type ExportShareRevokeRequestT,
  type VisitSummaryCreateRequestT,
  type MetadataMigrationBatchAcceptRequestT, type MetadataSuggestionAcceptRequestT,
  type SearchQueryT,
} from '@amr/contracts';

// 结构化 parser 类型 —— apps/web 只依赖 @amr/contracts,不 import zod(CI 断言 B1)
interface Parser<T> { parse: (value: unknown) => T }

// spec m1-05 §1:手写薄封装(无 codegen),每个函数以 contracts schema 校验出参。
export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8300';

const TOKEN_KEY = 'amr.token';
export const auth = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface CreatePersonInput {
  display_name: string;
  birth_date: string;
  sex_at_birth: 'male' | 'female' | 'unknown';
  relation_to_owner: 'spouse' | 'parent' | 'child' | 'sibling' | 'other';
}

async function call<T>(
  path: string,
  opts: { method?: string; body?: unknown; schema: Parser<T>; auth?: boolean },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth !== false) {
    const t = auth.get();
    if (t) headers['authorization'] = `Bearer ${t}`;
  }
  const res = await fetch(API_BASE + path, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    let code = 'unknown';
    let message = text.slice(0, 200);
    let details: Record<string, unknown> | undefined;
    try {
      const j = JSON.parse(text) as {
        error?: { code?: string; message?: string; details?: Record<string, unknown> };
      };
      code = j.error?.code ?? code;
      message = j.error?.message ?? message;
      details = j.error?.details;
    } catch { /* 非 JSON 错误体 */ }
    throw new ApiFailure(res.status, code, message, details);
  }
  return opts.schema.parse(text ? JSON.parse(text) : {});
}

async function callDownload(
  path: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<{ blob: Blob; filename: string }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const token = auth.get();
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(API_BASE + path, {
    method: opts.method ?? 'GET', headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    let code = 'unknown';
    let message = text.slice(0, 200);
    let details: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(text) as {
        error?: { code?: string; message?: string; details?: Record<string, unknown> };
      };
      code = parsed.error?.code ?? code;
      message = parsed.error?.message ?? message;
      details = parsed.error?.details;
    } catch { /* 非 JSON 错误体 */ }
    throw new ApiFailure(response.status, code, message, details);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? 'medical-record.zip';
  return { blob: await response.blob(), filename };
}

export function buildQueryString(values: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.toString();
}

export const api = {
  login: (email: string, password: string) =>
    call('/api/v1/auth/login', { method: 'POST', body: { email, password }, schema: LoginResponse, auth: false }),
  register: (body: {
    email: string;
    password: string;
    display_name: string;
    birth_date: string;
    sex_at_birth: 'male' | 'female' | 'unknown';
    timezone: string;
  }) => call('/api/v1/auth/register', { method: 'POST', body, schema: LoginResponse, auth: false }),
  account: () => call('/api/v1/account', { schema: AccountProfile }),
  capabilities: () => call('/api/v1/capabilities', { schema: CapabilitiesResponse }),
  deleteAccount: (currentPassword: string) =>
    call('/api/v1/account', {
      method: 'DELETE',
      body: { current_password: currentPassword, confirmation: 'DELETE' },
      schema: DeleteAccountResponse,
    }),
  people: () => call('/api/v1/people', { schema: PersonListResponse }),
  createPerson: (body: CreatePersonInput) =>
    call('/api/v1/people', { method: 'POST', body, schema: PersonResponse }),
  presign: (body: unknown) =>
    call('/api/v1/uploads/presign', { method: 'POST', body, schema: PresignResponse }),
  multipartCreate: (uploadFileId: string) =>
    call('/api/v1/uploads/multipart/create', {
      method: 'POST', body: { upload_file_id: uploadFileId }, schema: MultipartCreateResponse,
    }),
  multipartSign: (uploadId: string, partNumbers: number[]) =>
    call('/api/v1/uploads/multipart/sign', {
      method: 'POST', body: { upload_id: uploadId, part_numbers: partNumbers }, schema: MultipartSignResponse,
    }),
  multipartComplete: (uploadId: string, parts: Array<{ part_number: number; etag: string }>) =>
    call('/api/v1/uploads/multipart/complete', {
      method: 'POST', body: { upload_id: uploadId, parts }, schema: MultipartCompleteResponse,
    }),
  createDocument: (body: unknown) =>
    call('/api/v1/documents', { method: 'POST', body, schema: DocumentOut }),
  contextTemplates: () => call('/api/v1/context/templates', { schema: ContextTemplateManifestResponse }),
  contextTemplate: (templateId: string, version: number) =>
    call(`/api/v1/context/templates/${encodeURIComponent(templateId)}/versions/${version}`, {
      schema: ContextTemplateSnapshot,
    }),
  createContextSession: (body: ContextSessionCreateT) =>
    call('/api/v1/context/sessions', {
      method: 'POST', body, schema: ContextSessionMutationResponse,
    }),
  contextSession: (id: string) =>
    call(`/api/v1/context/sessions/${id}`, { schema: ContextSessionDetailResponse }),
  pendingContext: (personId: string, localDate: string, cursor?: string) =>
    call(`/api/v1/context/pending?${buildQueryString({
      person_id: personId, local_date: localDate, cursor, limit: 100,
    })}`, { schema: ContextPendingResponse }),
  bindContextDocument: (id: string, body: { client_operation_id: string; if_revision: number }) =>
    call(`/api/v1/context/sessions/${id}/bind-document`, {
      method: 'POST', body, schema: ContextSessionMutationResponse,
    }),
  upsertContextAnswers: (id: string, body: ContextAnswersUpsertRequestT) =>
    call(`/api/v1/context/sessions/${id}/answers`, {
      method: 'POST', body, schema: ContextSessionMutationResponse,
    }),
  completeContextSession: (id: string, body: { client_operation_id: string; if_revision: number }) =>
    call(`/api/v1/context/sessions/${id}/complete`, {
      method: 'POST', body, schema: ContextSessionMutationResponse,
    }),
  prepareContextUpload: (body: ContextUploadPrepareRequestT) =>
    call('/api/v1/context/uploads/prepare', {
      method: 'POST', body, schema: ContextUploadPrepareResponse,
    }),
  presignContextUpload: (id: string) =>
    call(`/api/v1/context/uploads/${id}/presign`, {
      method: 'POST', schema: ContextUploadPresignResponse,
    }),
  finalizeContextUpload: (
    id: string,
    body: { client_operation_id: string; parts: Array<{ part_number: number; etag: string }> },
  ) => call(`/api/v1/context/uploads/${id}/finalize`, {
    method: 'POST', body, schema: ContextUploadFinalizeResponse,
  }),
  contextUpload: (id: string) =>
    call(`/api/v1/context/uploads/${id}`, { schema: ContextUploadViewResponse }),
  medicalConcepts: (q = '', kind?: 'laboratory' | 'vital' | 'anthropometric' | 'derived', limit = 100) =>
    call(`/api/v1/medical/concepts?${buildQueryString({ q, kind, limit })}`, {
      schema: MedicalConceptListResponse,
    }),
  observations: (
    personId: string,
    q: Omit<Partial<ObservationListQueryT>, 'person_id'> = {},
  ) => call(`/api/v1/people/${personId}/observations?${buildQueryString({ ...q, limit: q.limit ?? 100 })}`, {
    schema: ObservationListResponse,
  }),
  createObservations: (personId: string, body: ObservationBatchCreateRequestT) =>
    call(`/api/v1/people/${personId}/observations:batch`, {
      method: 'POST', body, schema: ObservationBatchCreateResponse,
    }),
  patchObservation: (id: string, body: ObservationPatchRequestT) =>
    call(`/api/v1/observations/${id}`, { method: 'PATCH', body, schema: Observation }),
  archiveObservation: (id: string, body: ObservationArchiveRequestT) =>
    call(`/api/v1/observations/${id}/archive`, { method: 'POST', body, schema: Observation }),
  observationMappingInbox: (personId: string, cursor?: string) =>
    call(`/api/v1/people/${personId}/observation-mapping-inbox?${buildQueryString({ cursor, limit: 100 })}`, {
      schema: ObservationMappingInboxResponse,
    }),
  resolveObservationMapping: (personId: string, body: ObservationMappingResolveRequestT) =>
    call(`/api/v1/people/${personId}/observation-mapping-inbox:resolve`, {
      method: 'POST', body, schema: ObservationMappingResolveResponse,
    }),
  observationSuggestions: (documentId: string) =>
    call(`/api/v1/documents/${documentId}/observation-suggestions`, {
      schema: ObservationSuggestionListResponse,
    }),
  acceptObservationSuggestion: (
    documentId: string,
    suggestionId: string,
    body: ObservationSuggestionAcceptRequestT,
  ) => call(`/api/v1/documents/${documentId}/observation-suggestions/${suggestionId}/accept`, {
    method: 'POST', body, schema: ObservationSuggestionAcceptResponse,
  }),
  metricGroups: (personId: string, includeArchived = false) =>
    call(`/api/v1/people/${personId}/metric-groups?${buildQueryString({
      include_archived: includeArchived,
    })}`, { schema: MetricGroupListResponse }),
  createMetricGroup: (personId: string, body: MetricGroupCreateRequestT) =>
    call(`/api/v1/people/${personId}/metric-groups`, {
      method: 'POST', body, schema: MetricGroup,
    }),
  patchMetricGroup: (id: string, body: MetricGroupPatchRequestT) =>
    call(`/api/v1/metric-groups/${id}`, { method: 'PATCH', body, schema: MetricGroup }),
  archiveMetricGroup: (id: string, body: MetricGroupArchiveRequestT) =>
    call(`/api/v1/metric-groups/${id}/archive`, { method: 'POST', body, schema: MetricGroup }),
  metricGroupTrend: (id: string, q: {
    from?: string; to?: string; cursor?: string; limit?: number; max_points?: number;
  } = {}) => call(`/api/v1/metric-groups/${id}/trend?${buildQueryString({
    ...q, limit: q.limit ?? 1_000, max_points: q.max_points ?? 300,
  })}`, { schema: TrendResponse }),
  medications: (
    personId: string,
    q: Omit<Partial<MedicationListQueryT>, 'person_id'> = {},
  ) => call(`/api/v1/people/${personId}/medications?${buildQueryString({
    ...q, limit: q.limit ?? 100,
  })}`, { schema: MedicationListResponse }),
  createMedications: (personId: string, body: MedicationBatchCreateRequestT) =>
    call(`/api/v1/people/${personId}/medications:batch`, {
      method: 'POST', body, schema: MedicationBatchCreateResponse,
    }),
  patchMedication: (id: string, body: MedicationPatchRequestT) =>
    call(`/api/v1/medications/${id}`, { method: 'PATCH', body, schema: Medication }),
  archiveMedication: (id: string, body: MedicationArchiveRequestT) =>
    call(`/api/v1/medications/${id}/archive`, { method: 'POST', body, schema: Medication }),
  timelineEvents: (
    personId: string,
    q: Omit<Partial<TimelineEventListQueryT>, 'person_id'> = {},
  ) => call(`/api/v1/people/${personId}/timeline-events?${buildQueryString({
    include_undated: q.include_undated ?? true, ...q, limit: q.limit ?? 100,
  })}`, { schema: TimelineEventListResponse }),
  createTimelineEvent: (personId: string, body: TimelineEventCreateRequestT) =>
    call(`/api/v1/people/${personId}/timeline-events`, {
      method: 'POST', body, schema: TimelineEvent,
    }),
  patchTimelineEvent: (id: string, body: TimelineEventPatchRequestT) =>
    call(`/api/v1/timeline-events/${id}`, { method: 'PATCH', body, schema: TimelineEvent }),
  archiveTimelineEvent: (id: string, body: TimelineEventArchiveRequestT) =>
    call(`/api/v1/timeline-events/${id}/archive`, { method: 'POST', body, schema: TimelineEvent }),
  exportPreview: (body: ExportPreviewRequestT) =>
    call('/api/v1/exports/preview', { method: 'POST', body, schema: ExportPreviewResponse }),
  createVisitSummary: (body: VisitSummaryCreateRequestT) =>
    call('/api/v1/exports/visit-summary', { method: 'POST', body, schema: ExportJob }),
  exports: (personId: string, q: Omit<Partial<ExportListQueryT>, 'person_id'> = {}) =>
    call(`/api/v1/people/${personId}/exports?${buildQueryString({ ...q, limit: q.limit ?? 30 })}`, {
      schema: ExportListResponse,
    }),
  exportJob: (id: string) => call(`/api/v1/exports/${id}`, { schema: ExportJob }),
  retryExport: (id: string, body: ExportRetryRequestT) =>
    call(`/api/v1/exports/${id}/retry`, { method: 'POST', body, schema: ExportJob }),
  downloadExport: (id: string) => callDownload(`/api/v1/exports/${id}/download`),
  exportShares: (id: string) =>
    call(`/api/v1/exports/${id}/shares`, { schema: ExportShareListResponse }),
  createExportShare: (id: string, body: ExportShareCreateRequestT) =>
    call(`/api/v1/exports/${id}/shares`, {
      method: 'POST', body, schema: ExportShareCreateResponse,
    }),
  revokeExportShare: (id: string, shareId: string, body: ExportShareRevokeRequestT) =>
    call(`/api/v1/exports/${id}/shares/${shareId}`, {
      method: 'DELETE', body, schema: ExportShare,
    }),
  documents: (q: Partial<DocumentListQueryT> & Pick<DocumentListQueryT, 'person_id'>) =>
    call(`/api/v1/documents?${buildQueryString(q)}`, { schema: DocumentListResponse }),
  documentDetail: (id: string) => call(`/api/v1/documents/${id}`, { schema: DocumentDetailResponse }),
  patchDocumentMetadata: (id: string, body: DocumentMetadataPatchT) =>
    call(`/api/v1/documents/${id}/metadata`, {
      method: 'PATCH', body, schema: DocumentMetadataMutationResponse,
    }),
  search: (q: SearchQueryT) => call(`/api/v1/search?${buildQueryString(q)}`, { schema: SearchResponse }),
  facilities: (q?: string) => call(`/api/v1/facilities?${buildQueryString({ q })}`, { schema: FacilityListResponse }),
  encounters: (personId: string, cursor?: string) =>
    call(`/api/v1/people/${personId}/encounters?${buildQueryString({ cursor, limit: 100 })}`, {
      schema: EncounterListResponse,
    }),
  createEncounter: (personId: string, body: EncounterCreateT) =>
    call(`/api/v1/people/${personId}/encounters`, { method: 'POST', body, schema: Encounter }),
  patchEncounter: (id: string, body: EncounterPatchT) =>
    call(`/api/v1/encounters/${id}`, { method: 'PATCH', body, schema: Encounter }),
  setEncounterDocuments: (id: string, body: EncounterDocumentsSetT) =>
    call(`/api/v1/encounters/${id}/documents`, {
      method: 'POST', body, schema: EncounterDocumentsSetResponse,
    }),
  metadataSuggestions: (documentId: string) =>
    call(`/api/v1/documents/${documentId}/metadata-suggestions`, { schema: MetadataSuggestionListResponse }),
  metadataMigrationInbox: (personId: string, cursor?: string) =>
    call(`/api/v1/metadata-migration-inbox?${buildQueryString({ person_id: personId, cursor, limit: 50 })}`, {
      schema: MetadataMigrationInboxResponse,
    }),
  acceptMetadataSuggestion: (
    documentId: string,
    suggestionId: string,
    body: MetadataSuggestionAcceptRequestT,
  ) => call(`/api/v1/documents/${documentId}/metadata-suggestions/${suggestionId}/accept`, {
    method: 'POST', body, schema: MetadataSuggestionAcceptResponse,
  }),
  batchAcceptMetadataSuggestions: (body: MetadataMigrationBatchAcceptRequestT) =>
    call('/api/v1/metadata-migration-inbox:batch-accept', {
      method: 'POST', body, schema: MetadataMigrationBatchAcceptResponse,
    }),
  downloadPersonBundle: (personId: string) =>
    callDownload('/api/v1/exports/person-bundle', {
      method: 'POST', body: { person_id: personId },
    }),
  normalizationDecisions: () =>
    call('/api/v1/normalization-decisions', { schema: NormalizationDecisionListResponse }),
  confirmNormalization: (
    id: string,
    decision: 'confirmed' | 'rejected',
    clientOperationId: string,
  ) => call(`/api/v1/normalization-decisions/${id}/confirm`, {
    method: 'POST',
    body: { decision, client_operation_id: clientOperationId },
    schema: NormalizationConfirmResponse,
  }),
  archiveDocument: (id: string, archived: boolean, reason: string, clientOperationId: string) =>
    call(`/api/v1/documents/${id}`, {
      method: 'PATCH', body: { archived, reason, client_operation_id: clientOperationId }, schema: ArchiveResponse,
    }),
  acknowledgePersonCheck: (id: string, reason: string, clientOperationId: string) =>
    call(`/api/v1/documents/${id}/person-check/ack`, {
      method: 'POST', body: { reason, client_operation_id: clientOperationId }, schema: PersonCheckAckResponse,
    }),
  reassignDocument: (id: string, toPersonId: string, reason: string, clientOperationId: string) =>
    call(`/api/v1/documents/${id}/reassign`, {
      method: 'POST', body: { to_person_id: toPersonId, reason, client_operation_id: clientOperationId },
      schema: CorrectionResponse,
    }),
  discard: (body: CaptureDiscardRequestT) =>
    call<{ recorded: true }>('/api/v1/captures/discard', {
      method: 'POST', body, schema: { parse: (v) => v as { recorded: true } },
    }),
};

export const sharedExportUrl = (token: string) =>
  `${API_BASE}/api/v1/shared/exports/${encodeURIComponent(token)}`;

export const derivativeUrl = (documentId: string, pageNo: number, variant: 'thumb' | 'preview') =>
  `${API_BASE}/api/v1/documents/${documentId}/pages/${pageNo}/${variant}`;
