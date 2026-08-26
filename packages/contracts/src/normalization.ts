import { z } from 'zod';
import { DocShortId, IsoDate, IsoDateTime, Sha256Hex, Uuid } from './scalars.js';

// spec m2-05 §2:判断归 AI,执行归确定性代码,判断本身持久化(ADR-040)。

export const NormalizationKind = z.enum(['facility', 'encounter']);
export const NormalizationState = z.enum(['proposed', 'confirmed', 'rejected']);

/** m2-05 §1.3 的唯一归一实现。姓名对账与机构指纹必须共享完全相同的
 * NFKC/大小写/空白/分隔符规则，禁止在调用点各写一份“差不多”的 norm。 */
export const IDENTITY_SEPARATORS = [
  '·', '‧', '•', '・', '.', '。', ',', '、', '-', '‐', '‑', '‒', '–', '—', '_', '/', '\\',
] as const;

const IDENTITY_SEPARATOR_RE = new RegExp(
  `[${IDENTITY_SEPARATORS.map((char) => `\\${char}`).join('')}]`,
  'g',
);

export function normalizeIdentity(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{White_Space}/gu, '')
    .replace(IDENTITY_SEPARATOR_RE, '');
}

/** facility 归一的提议载荷。确认时会被原样写进 _index/decisions/ 的 payload ——
 *  它必须自带重建 facility 行所需的全部事实(m2-07 §5)。 */
export const FacilityProposal = z
  .object({
    facility: z
      .object({
        slug: z.string().regex(/^f[23456789abcdefghjkmnpqrstvwxyz]{5}$/),
        name: z.string().min(1),
        city: z.string().nullable(),
        level: z.string().nullable(),
      })
      .strict(),
    matched_raw_names: z.array(z.string()).min(1),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(500),
  })
  .strict();

/** facility 归一模型只负责语义判断；slug 生成、DB 写入与批量回填仍由确定性执行层完成。 */
export const FacilityNormalizationModelOut = z
  .object({
    action: z.enum(['match_existing', 'create']),
    existing_facility_slug: z.string().nullable(),
    name: z.string().min(1),
    city: z.string().nullable(),
    level: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(500),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'match_existing' && value.existing_facility_slug === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['existing_facility_slug'], message: '匹配既有机构时必须给出 slug' });
    }
    if (value.action === 'create' && value.existing_facility_slug !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['existing_facility_slug'], message: '新建机构时 slug 必须为空' });
    }
  });

export const NormalizationDecision = z
  .object({
    id: Uuid,
    kind: NormalizationKind,
    input_fingerprint: Sha256Hex,
    proposal: z.record(z.unknown()),
    state: NormalizationState,
    decided_by: Uuid.nullable(),
    decided_at: IsoDateTime.nullable(),
    client_operation_id: Uuid.nullable(),
    prompt_id: z.string().nullable(),
    prompt_version: z.number().int().nullable(),
    model: z.string().nullable(),
    created_at: IsoDateTime,
  })
  .strict();

export const NormalizationConfirmRequest = z.object({
  decision: z.enum(['confirmed', 'rejected']),
  client_operation_id: Uuid,
});

export const NormalizationDecisionListQuery = z.object({
  kind: NormalizationKind.optional(),
  state: NormalizationState.optional(),
});

export const NormalizationDecisionListResponse = z.object({
  decisions: z.array(NormalizationDecision),
});

export const NormalizationConfirmResponse = z.object({ decision: NormalizationDecision });

/** 归一指纹(m2-05 §2.2)。**不含 city_hint** —— 它在 M2 没有可靠来源,
 *  而 canonical() 对"键缺省"与"键为 null"产出的字节不同 ⇒ 同一家医院两次指纹不同
 *  ⇒ 决策缓存失效(审核 #004 B-2)。 */
export interface FacilityFingerprintInput { raw_name: string }

export const GroupingBasis = z.enum(['event_time', 'capture_date_degraded']);

export const EncounterCandidateDocument = z.object({
  id: Uuid,
  short_id: z.string(),
  facility_id: Uuid,
  doc_type: z.string(),
  event_time: IsoDateTime.nullable(),
  sampled_on: IsoDate.nullable(),
  reported_on: IsoDate.nullable(),
  capture_date: IsoDate,
  department_raw: z.string().nullable(),
  timezone: z.string().min(1),
}).strict();

export const EncounterCandidatePair = z.object({
  document_ids: z.tuple([Uuid, Uuid]),
  grouping_basis: GroupingBasis,
}).strict();

/** AI 只判断确定性预筛出的二元候选是否属于同一次就诊。 */
export const EncounterSuggestionModelOut = z.object({
  judgments: z.array(z.object({
    document_ids: z.tuple([Uuid, Uuid]),
    same_encounter: z.boolean(),
    encounter_type: z.enum(['outpatient', 'inpatient', 'emergency', 'checkup', 'other']),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(500),
  }).strict()),
}).strict();

/** 人工确认后创建 encounter 所需的完整、可回放事实。 */
export const EncounterProposal = z.object({
  encounter_id: Uuid,
  person_id: Uuid,
  document_ids: z.array(Uuid).length(2),
  document_short_ids: z.array(DocShortId).length(2),
  facility_id: Uuid,
  grouping_basis: GroupingBasis,
  encounter_type: z.enum(['outpatient', 'inpatient', 'emergency', 'checkup', 'other']),
  occurred_on: IsoDate,
  occurred_at: IsoDateTime.nullable(),
  department: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
}).strict();

export type NormalizationDecisionT = z.infer<typeof NormalizationDecision>;
export type FacilityProposalT = z.infer<typeof FacilityProposal>;
export type FacilityNormalizationModelOutT = z.infer<typeof FacilityNormalizationModelOut>;
export type EncounterCandidateDocumentT = z.infer<typeof EncounterCandidateDocument>;
export type EncounterCandidatePairT = z.infer<typeof EncounterCandidatePair>;
export type EncounterSuggestionModelOutT = z.infer<typeof EncounterSuggestionModelOut>;
export type EncounterProposalT = z.infer<typeof EncounterProposal>;
