import { z } from 'zod';
import { DocType } from './enums.js';
import { DocShortId, IsoDate, IsoDateTime, LocalOrOffsetDateTime } from './scalars.js';

// spec m2-03 §1:Stage 1 输出。全部 .strict() —— 未知键即失败,与 sidecar 同一纪律。
// 单一出处:packages/ai 的 prompt 与调用点一律引用此处,禁止重复维护枚举。

export const PiiKind = z.enum(['phone', 'id_card', 'address', 'insurance_card', 'bank_card', 'other']);

export const Stage1Page = z
  .object({
    page_no: z.number().int().min(1),
    page_label: z.string().nullable(),        // 页脚原文,如「第 1 页,共 2 页」
    page_index: z.number().int().nullable(),  // 从 page_label 解析出的页序
    page_total: z.number().int().nullable(),
    full_text: z.string(),                    // 该页完整文本,保留原始换行与表格结构
  })
  .strict();

export const Stage1PiiSpan = z
  .object({
    page_no: z.number().int().min(1),
    kind: PiiKind,
    start: z.number().int().min(0),           // 该页 full_text 的 UTF-16 码元偏移
    end: z.number().int().min(0),             // 半开区间 [start, end)
  })
  .strict()
  .refine((s) => s.end > s.start, 'PII span 必须非空且 end > start');

export const Stage1Out = z
  .object({
    doc_type: DocType,
    doc_type_confidence: z.number().min(0).max(1),
    patient_name: z.string().nullable(),
    patient_sex: z.enum(['male', 'female', 'unknown']).nullable(),
    patient_age_text: z.string().nullable(),
    patient_identifiers: z.array(z.object({ type: z.string(), value: z.string() }).strict()),
    facility_name_raw: z.string().nullable(),
    department_raw: z.string().nullable(),
    sampled_on: IsoDate.nullable(),
    reported_on: IsoDate.nullable(),
    // 报告确实印有时分时才填(审核 #003 A2):没有时分就是没有,不许用日期造一个假的
    event_at: IsoDateTime.nullable(),
    summary: z.string(),
    pages: z.array(Stage1Page).min(1),
    pii_spans: z.array(Stage1PiiSpan),
    boundary_hint: z
      .object({ likely_same_document: z.boolean(), reason: z.string() })
      .strict()
      .nullable(),
    unmodeled: z.array(                        // 残差通道(ADR-043):装不进 schema 的必须进这里,禁止丢弃
      z.object({ label: z.string(), value: z.string(), page_no: z.number().int().min(1) }).strict(),
    ),
  })
  .strict();

/** S1 工件(落 derived/{slug}/{sid}/extractions/s1@{v}.json,属 L2)。
 *
 *  注意:它的 schema_version 刻意**不进** SCHEMA_VERSIONS —— 那份清单驱动 `_meta/schemas`,
 *  而 `_meta` 是**给二十年后拿到这个桶的人看的 L1 自述层**。L2 工件不进打包、不进备份、
 *  随时可重跑,把它的 schema 混进自述层只会模糊"什么才是权威"这条线。 */
export const S1Artifact = z
  .object({
    schema_version: z.literal('1.0'),
    stage: z.literal('s1'),
    document_short_id: DocShortId,
    produced_at: IsoDateTime,
    // ★ 实际服务模型:fallback 生效时这里是 fallback 模型,否则"同 prompt 版本产出口径一致"不成立
    model: z.string(),
    prompt_id: z.string(),
    prompt_version: z.number().int().min(1),
    prompt_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    effort: z.string(),
    batches: z.number().int().min(1),          // >1 表示这是拼出来的,必须可识别
    usage: z
      .object({
        input_tokens: z.number().int(),
        output_tokens: z.number().int(),
        cache_read_input_tokens: z.number().int(),
        cache_creation_input_tokens: z.number().int(),
      })
      .strict(),
    output: Stage1Out,
  })
  .strict();

export type Stage1OutT = z.infer<typeof Stage1Out>;

/** 模型响应的**解析**层。线上契约(Stage1Out)保持严格 —— 它同时是发给模型的 json_schema
 *  与 artifact 的存储类型,改动会让请求指纹漂移、既有 cassette 基线全部失配。
 *
 *  但解析必须宽容:实测(e2e 2026-08-30)模型把患者、机构、科室、日期全部读对,
 *  只因 event_at 写成单据上印的 "2026-08-21T19:08:00"(无时区)就被整份丢弃。
 *  纸上印的时分本来就没有时区,补一个偏移是编造;拒收则是把正确识别当垃圾扔掉。
 *  这里接受两种时刻形态、并让不合规的日期各自退化为 null,再由 handler 按账户时区
 *  归一成带偏移的瞬时,交回严格层落库。 */
export const Stage1OutLenient = Stage1Out.extend({
  sampled_on: IsoDate.nullable().catch(null),
  reported_on: IsoDate.nullable().catch(null),
  event_at: LocalOrOffsetDateTime.nullable().catch(null),
});
export type Stage1OutLenientT = z.infer<typeof Stage1OutLenient>;

export type Stage1PageT = z.infer<typeof Stage1Page>;
export type S1ArtifactT = z.infer<typeof S1Artifact>;
