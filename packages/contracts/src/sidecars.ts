import { z } from 'zod';
import { Uuid, IsoDate, IsoDateTime, DocShortId, PersonSlug, Sha256Hex } from './scalars.js';
import { DocumentSource, MimeType } from './enums.js';

// spec m0-03 §4。全部 .strict() —— 未知键即失败。

export const CapturePage = z
  .object({
    page_no: z.number().int().min(1),
    file: z.string(),
    sha256: Sha256Hex,
    bytes: z.number().int().min(1),
    mime: MimeType,
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  })
  .strict();

export const CaptureSidecar = z
  .object({
    schema_version: z.literal('2.0'),
    document_id: Uuid,
    short_id: DocShortId,
    person: z
      .object({
        slug: PersonSlug,
        // 登记时刻 display_name 快照,永不回写(spec m0-03 §4 / 审核 #001 B-2)
        name: z.string(),
        confirmed_by: z.enum(['api', 'capture_ui', 'import']),
      })
      .strict(),
    captured_at: IsoDateTime, // 客户端原文,带原始 offset
    capture_date: IsoDate,
    source: DocumentSource,
    uploaded_by: Uuid,
    client_document_id: z.string().min(8).max(64), // 上传瞬间事实(specs/m0/CHANGES.md #1)
    original_filename: z.string().nullable(),
    pages: z.array(CapturePage).min(1),
    created_at: IsoDateTime,
  })
  .strict();

export const PageSidecar = z
  .object({
    schema_version: z.literal('2.0'),
    document_short_id: DocShortId,
    page_no: z.number().int().min(1),
    file: z.string(),
    sha256: Sha256Hex,
    bytes: z.number().int().min(1),
    mime: MimeType,
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    // M0 缺省可空:服务端不解析图像([偏差:vs 04 §3 —— M1 采集端补])
    exif: z
      .object({ captured_at: IsoDateTime.nullable(), orientation: z.number().int().nullable() })
      .strict()
      .nullable(),
  })
  .strict();

export const CorrectionSidecar = z
  .object({
    schema_version: z.literal('1.0'),
    seq: z.number().int().min(1),
    kind: z.literal('person_reassign'),
    from_person_slug: PersonSlug,
    to_person_slug: PersonSlug,
    reason: z.string(),
    corrected_at: IsoDateTime,
  })
  .strict();

export const ManifestAdd = z
  .object({
    schema_version: z.literal('1.0'),
    event_id: Uuid, // uuid v7,回放幂等键(审核 #001 #14)
    op: z.literal('add'),
    doc_short_id: DocShortId,
    person_slug: PersonSlug,
    prefix: z.string(),
    created_at: IsoDateTime,
  })
  .strict();

export const ManifestPersonCorrect = z
  .object({
    schema_version: z.literal('1.0'),
    event_id: Uuid,
    op: z.literal('person_correct'),
    doc_short_id: DocShortId,
    to_person_slug: PersonSlug,
    created_at: IsoDateTime,
  })
  .strict();

export const ManifestLine = z.discriminatedUnion('op', [ManifestAdd, ManifestPersonCorrect]);
