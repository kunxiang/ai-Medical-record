import {
  AccountProfile, ArchiveResponse, CorrectionResponse, DeleteAccountResponse, DocumentListResponse, DocumentOut, LoginResponse,
  MultipartCompleteResponse, MultipartCreateResponse, MultipartSignResponse,
  NormalizationConfirmResponse, NormalizationDecisionListResponse, PersonListResponse, PresignResponse,
  Person as PersonResponse, PersonCheckAckResponse,
  type CaptureDiscardRequestT,
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
  constructor(readonly status: number, readonly code: string, message: string) {
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
    try {
      const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
      code = j.error?.code ?? code;
      message = j.error?.message ?? message;
    } catch { /* 非 JSON 错误体 */ }
    throw new ApiFailure(res.status, code, message);
  }
  return opts.schema.parse(text ? JSON.parse(text) : {});
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
  documents: (q: { person_id: string; cursor?: string; limit?: number; include_archived?: boolean }) => {
    const p = new URLSearchParams({ person_id: q.person_id });
    if (q.cursor) p.set('cursor', q.cursor);
    if (q.limit) p.set('limit', String(q.limit));
    if (q.include_archived) p.set('include_archived', 'true');
    return call(`/api/v1/documents?${p}`, { schema: DocumentListResponse });
  },
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

export const derivativeUrl = (documentId: string, pageNo: number, variant: 'thumb' | 'preview') =>
  `${API_BASE}/api/v1/documents/${documentId}/pages/${pageNo}/${variant}`;
