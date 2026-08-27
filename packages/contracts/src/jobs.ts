import { z } from 'zod';
import { IsoDateTime, Uuid } from './scalars.js';

// spec m2-04:后台任务队列。ai_job 属 L2 —— 删库重建后为空,
// 禁止因缺少 job 记录而使任何 L1 数据不可用。

export const AiJobKind = z.enum(['stage1', 'facility_normalize', 'encounter_suggest']);
export const AiJobState = z.enum(['pending', 'running', 'done', 'failed', 'needs_human', 'unsupported']);

export const AiJobError = z
  .object({
    stage: z.string(),
    code: z.string(),
    message: z.string().max(1000),
    // 非 refusal 错误的生产端不写 category；解析旧记录时统一补为 null。
    category: z.string().nullable().default(null),
    at: IsoDateTime,
  })
  .strict();

export const AiJobItem = z
  .object({
    id: Uuid,
    kind: AiJobKind,
    state: AiJobState,
    document_id: Uuid.nullable(),
    person_id: Uuid.nullable(),        // facility_normalize 是家庭级作业(审核 #004 A-7)
    attempt: z.number().int().min(0),
    next_attempt_at: IsoDateTime,
    last_error: AiJobError.nullable(),
    result_key: z.string().nullable(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .strict();

export const AiJobListQuery = z.object({
  state: AiJobState.optional(),
  kind: AiJobKind.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export const AiJobListResponse = z.object({
  jobs: z.array(AiJobItem),
  next_cursor: z.string().nullable(),
});

export const AiRerunRequest = z.object({
  kind: AiJobKind,
  force_prompt_version: z.number().int().min(1).optional(),
});
export const AiRerunResponse = z.object({ job_id: Uuid, state: AiJobState });

/** dedup_key 的构造(m2-04 §2.1)。**单一出处** —— 散落在调用点会导致某一处静默写错,
 *  而写错的表现是"作业莫名其妙只出现过一次",不报任何错。 */
export const dedupKey = {
  stage1: (documentId: string) => `stage1:${documentId}`,
  facilityNormalize: (inputFingerprint: string) => `facility:${inputFingerprint}`,
  // ★ person 级合并型:按日历日切分会与 m2-05 §3「禁止按日历日」自相矛盾,
  //   且 23:50 / 次日 00:30 那一对会落进两条不同作业,谁负责评估说不清(审核 #004 A-6)。
  encounterSuggest: (personId: string) => `encounter:${personId}`,
} as const;

export type AiJobItemT = z.infer<typeof AiJobItem>;
export type AiJobKindT = z.infer<typeof AiJobKind>;
export type AiJobStateT = z.infer<typeof AiJobState>;
