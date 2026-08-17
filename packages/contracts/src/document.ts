import { z } from 'zod';
import { Uuid, IsoDate, IsoDateTime, DocShortId, Sha256Hex } from './scalars.js';
import { DocumentSource, DocumentStatus, DocType, MimeType } from './enums.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PAGES = 99;

export const PresignFileIn = z.object({
  filename: z.string().min(1).max(255),
  mime_type: MimeType,
  byte_size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  sha256: Sha256Hex,
});
export const PresignRequest = z.object({
  person_id: Uuid,
  files: z.array(PresignFileIn).min(1).max(MAX_PAGES),
});
export const PresignResponse = z.object({
  batch_id: Uuid,
  doc_short_id: DocShortId,
  uploads: z.array(
    z.object({
      upload_id: Uuid,
      url: z.string().url(),
      method: z.literal('PUT'),
      headers: z.record(z.string()),
      expires_at: IsoDateTime,
    }),
  ),
});

export const PageIn = z.object({
  upload_id: Uuid,
  page_no: z.number().int().min(1).max(MAX_PAGES),
  width: z.number().int().min(1),  // PDF:首页 MediaBox 宽取整 pt(≥1)
  height: z.number().int().min(1),
  sha256: Sha256Hex,
});

// captured_at ∈ [2000-01-01, now+24h] 的校验需要"现在",由服务端在 defineRoute 后追加执行
export const CAPTURED_AT_MIN = '2000-01-01T00:00:00Z';
export const CAPTURED_AT_SKEW_MS = 24 * 3600 * 1000;
export function capturedAtInRange(capturedAt: string, now: Date): boolean {
  const t = Date.parse(capturedAt);
  return t >= Date.parse(CAPTURED_AT_MIN) && t <= now.getTime() + CAPTURED_AT_SKEW_MS;
}

export const DocumentCreate = z.object({
  person_id: Uuid,
  person_confirmed: z.literal(true),
  batch_id: Uuid,
  source: DocumentSource,
  captured_at: IsoDateTime,
  pages: z
    .array(PageIn)
    .min(1)
    .max(MAX_PAGES)
    .refine(
      (ps) =>
        new Set(ps.map((p) => p.page_no)).size === ps.length &&
        Math.min(...ps.map((p) => p.page_no)) === 1 &&
        Math.max(...ps.map((p) => p.page_no)) === ps.length,
      'page_no 必须为从 1 起的连续序列',
    ),
  client_document_id: z.string().min(8).max(64),
});

export const DocumentPageOut = z.object({
  page_no: z.number().int(),
  storage_key: z.string(),
  sha256: Sha256Hex,
  byte_size: z.number().int(),
  mime_type: MimeType,
  width: z.number().int(),
  height: z.number().int(),
});
export const DocumentOut = z.object({
  id: Uuid,
  short_id: DocShortId,
  person_id: Uuid,
  status: DocumentStatus,
  doc_type: DocType,
  source: DocumentSource,
  captured_at: IsoDateTime,
  capture_date: IsoDate,
  original_filename: z.string().nullable(),
  pages: z.array(DocumentPageOut),
  created_at: IsoDateTime,
});

export const PageUrlResponse = z.object({ url: z.string().url(), expires_at: IsoDateTime });
