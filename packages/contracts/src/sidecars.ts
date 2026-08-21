import { z } from 'zod';
import { Uuid, IsoDate, IsoDateTime, DocShortId, PersonSlug, Sha256Hex } from './scalars.js';
import { DocumentSource, MimeType } from './enums.js';

// spec m0-03 §4。全部 .strict() —— 未知键即失败。

export const CapturePage = z
  .object({
    page_no: z.number().int().min(1),
    capture_order: z.number().int().min(1),   // ADR-047:拍摄序,拍摄瞬间即知的 L1 事实
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

// m2-01 §6:扩为判别联合并升 1.1。page_move 承载 D7 的拆分/合并/移页 ——
// 拆分与合并均分解为一组 page_move,不另立类型。
const CorrectionBase = {
  schema_version: z.literal('1.1'),
  seq: z.number().int().min(1),
  corrected_at: IsoDateTime,
  client_operation_id: Uuid,     // 幂等由它承担,**不由 seq 承担**(审核 #004 C-5)
};

export const CorrectionPersonReassign = z
  .object({
    ...CorrectionBase,
    kind: z.literal('person_reassign'),
    from_person_slug: PersonSlug,
    to_person_slug: PersonSlug,
    reason: z.string(),
  })
  .strict();

export const CorrectionPageMove = z
  .object({
    ...CorrectionBase,
    kind: z.literal('page_move'),
    from_doc_short_id: DocShortId,
    to_doc_short_id: DocShortId,
    // ★ 用内容摘要定位页,不用 key:key 中的 NN 是拍摄序且永不改名(ADR-047),
    //   移页之后 key 与所属文档不再对应,只有摘要是稳定锚点。
    page_sha256: Sha256Hex,
    from_page_no: z.number().int().min(1),
    to_page_no: z.number().int().min(1),
  })
  .strict();

export const CorrectionSidecar = z.discriminatedUnion('kind', [
  CorrectionPersonReassign, CorrectionPageMove,
]);

/** 全局重放排序键(m2-06 §3.1d)。seq 是**目录内**计数器,跨目录做次键无意义;
 *  禁止改用 S3 的 LastModified(不确定、可被复制改变)。 */
export function correctionSortKey(c: z.infer<typeof CorrectionSidecar>, fromDoc: string): string {
  return `${c.corrected_at}|${fromDoc}|${String(c.seq).padStart(4, '0')}`;
}

export const ManifestAdd = z
  .object({
    schema_version: z.literal('1.0'),
    event_id: Uuid, // uuid v7,回放幂等键(审核 #001 #14)
    op: z.literal('add'),
    doc_short_id: DocShortId,
    person_slug: PersonSlug,
    prefix: z.string(),
    created_at: IsoDateTime,
    // m2-01 §3.5:拆分产生的新文档也要有 add 行,但必须能与采集产生的区分开。
    // 它共用源文档的物理前缀(D7 不动原件的直接后果),且自己写了一份 capture.json。
    origin: z.enum(['capture', 'split']).default('capture'),
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
