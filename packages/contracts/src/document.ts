import { z } from 'zod';
import { Uuid, IsoDate, IsoDateTime, DocShortId, Sha256Hex } from './scalars.js';
import { DocumentSource, DocumentStatus, DocType, MimeType } from './enums.js';
import { canonicalJsonString } from './canonical.js';

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

// 采集端读到的 EXIF(纯解析,原件字节零改动;m1-01 §A2)
export const PageExif = z
  .object({
    captured_at: IsoDateTime.nullable(),          // DateTimeOriginal
    orientation: z.number().int().min(1).max(8).nullable(),
  })
  .strict();

export const PageIn = z.object({
  upload_id: Uuid,
  page_no: z.number().int().min(1).max(MAX_PAGES),
  capture_order: z.number().int().min(1).max(MAX_PAGES).default(1), // ADR-047:key 中的 NN 恒为拍摄序
  width: z.number().int().min(1),  // PDF:首页 MediaBox 宽取整 pt(≥1)
  height: z.number().int().min(1),
  sha256: Sha256Hex,
  exif: PageExif.nullable().default(null),
});

// captured_at ∈ [2000-01-01, now+24h] 的校验需要"现在",由服务端在 defineRoute 后追加执行
export const CAPTURED_AT_MIN = '2000-01-01T00:00:00Z';
export const CAPTURED_AT_SKEW_MS = 24 * 3600 * 1000;
export function capturedAtInRange(capturedAt: string, now: Date): boolean {
  const t = Date.parse(capturedAt);
  return t >= Date.parse(CAPTURED_AT_MIN) && t <= now.getTime() + CAPTURED_AT_SKEW_MS;
}

export const ConfirmedBy = z.enum(['api', 'capture_ui', 'import']);

export const DocumentCreate = z.object({
  person_id: Uuid,
  person_confirmed: z.literal(true),
  confirmed_by: ConfirmedBy.default('api'),   // PWA 一律传 capture_ui(ADR-041 的 L1 载体)
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

// ── 幂等指纹(m0/CHANGES #4 · m1-01 §A3)────────────────────────────────
// 稳定语义子集:排除 batch_id/upload_id(传输载体)与 exif(客户端解析,允许版本差异)。
// 旧口径把 batch_id 算进 payload ⇒ "每次重试重新 presign" 必然 409 终止。
export function idempotencyFingerprint(input: z.infer<typeof DocumentCreate>): string {
  return canonicalJsonString({
    client_document_id: input.client_document_id,
    person_id: input.person_id,
    captured_at: input.captured_at,
    source: input.source,
    confirmed_by: input.confirmed_by,
    pages: [...input.pages]
      .sort((a, b) => a.page_no - b.page_no)
      .map((p) => ({
        page_no: p.page_no, sha256: p.sha256,
        width: p.width, height: p.height, capture_order: p.capture_order,
      })),
  });
}

// ── M1:文档列表 ────────────────────────────────────────────────────────
export const DocumentListQuery = z.object({
  person_id: Uuid,
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const DocumentListItem = z.object({
  id: Uuid, short_id: DocShortId, person_id: Uuid,
  capture_date: IsoDate, captured_at: IsoDateTime,
  page_count: z.number().int(), doc_type: DocType, status: DocumentStatus,
  original_filename: z.string().nullable(),
  first_page: z.object({ page_no: z.number().int(), mime_type: MimeType }).nullable(),
});

export const DocumentListResponse = z.object({
  documents: z.array(DocumentListItem),
  next_cursor: z.string().nullable(),
});

// base64url:纯实现,浏览器与 Node 均可用(contracts 被 PWA 引用,禁止依赖 Buffer)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function toB64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += B64[c & 63]!;
  }
  return out;
}
function fromB64Url(s: string): Uint8Array {
  const bytes: number[] = [];
  let acc = 0, bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('bad cursor');
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  return Uint8Array.from(bytes);
}

export function encodeCursor(capturedAtIso: string, documentId: string): string {
  return toB64Url(new TextEncoder().encode(`${capturedAtIso}|${documentId}`));
}
export function decodeCursor(cursor: string): { capturedAt: string; documentId: string } {
  const raw = new TextDecoder().decode(fromB64Url(cursor));
  const i = raw.lastIndexOf('|');
  if (i < 0) throw new Error('bad cursor');
  return { capturedAt: raw.slice(0, i), documentId: raw.slice(i + 1) };
}

// ── M1:放弃采集 ────────────────────────────────────────────────────────
export const CaptureDiscardRequest = z.object({
  person_id: Uuid,
  client_document_id: z.string().min(8).max(64),
  discard_event_id: Uuid,          // 客户端持久化 ⇒ 重放天然幂等
  captured_at: IsoDateTime,
  page_count: z.number().int().min(1),
  reason: z.enum(['user_discarded', 'terminal_error']),
  detail: z.string().max(500).nullable().default(null),
});
export const CaptureDiscardResponse = z.object({ recorded: z.literal(true) });

export type DocumentCreateT = z.infer<typeof DocumentCreate>;
export type DocumentOutT = z.infer<typeof DocumentOut>;
export type DocumentListItemT = z.infer<typeof DocumentListItem>;
export type DocumentListResponseT = z.infer<typeof DocumentListResponse>;
export type PresignResponseT = z.infer<typeof PresignResponse>;
export type CaptureDiscardRequestT = z.infer<typeof CaptureDiscardRequest>;
export type PageInT = z.infer<typeof PageIn>;
