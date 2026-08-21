import { z } from 'zod';
import { IsoDateTime, Sha256Hex, Uuid } from './scalars.js';

// spec m2-05 §2:判断归 AI,执行归确定性代码,判断本身持久化(ADR-040)。

export const NormalizationKind = z.enum(['facility', 'encounter']);
export const NormalizationState = z.enum(['proposed', 'confirmed', 'rejected']);

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
  })
  .strict();

export const NormalizationDecision = z
  .object({
    id: Uuid,
    kind: NormalizationKind,
    input_fingerprint: Sha256Hex,
    proposal: z.record(z.unknown()),
    state: NormalizationState,
    decided_by: Uuid.nullable(),
    decided_at: IsoDateTime.nullable(),
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

/** 归一指纹(m2-05 §2.2)。**不含 city_hint** —— 它在 M2 没有可靠来源,
 *  而 canonical() 对"键缺省"与"键为 null"产出的字节不同 ⇒ 同一家医院两次指纹不同
 *  ⇒ 决策缓存失效(审核 #004 B-2)。 */
export interface FacilityFingerprintInput { raw_name: string }

export const GroupingBasis = z.enum(['event_time', 'capture_date_degraded']);

export type NormalizationDecisionT = z.infer<typeof NormalizationDecision>;
export type FacilityProposalT = z.infer<typeof FacilityProposal>;
