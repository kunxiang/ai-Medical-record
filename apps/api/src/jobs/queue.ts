import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { AiJobKindT, AiJobStateT } from '@amr/contracts';
import { db, type Tx } from '../db/client.js';
import { aiJob } from '../db/schema.js';

// spec m2-04:后台任务队列。用 PostgreSQL SKIP LOCKED,**禁止**引入队列中间件 ——
// 多一个有状态组件就多一份备份、监控和灾难恢复面积,而这个量级完全用不着。

const MAX_ATTEMPT = 5;
const BACKOFF_CAP_MS = 300_000;
/** 僵尸阈值:超过它仍停在 running 的行会被回收。没有这条,一次进程崩溃
 *  就让作业永久卡在 running —— M0 验收里同类问题(uploading 卡死)已付过一次学费。 */
const ZOMBIE_MS = 15 * 60_000;

/** 全抖动退避(与 m1-04 §4 同构) */
export function backoffMs(attempt: number): number {
  const base = Math.min(2 ** attempt * 1000, BACKOFF_CAP_MS);
  return Math.floor(base * (0.5 + Math.random() / 2));
}

/**
 * 投递作业。**必须在登记文档的同一事务内调用**(m2-04 §4.1)——
 * 否则"文档已登记但作业没投递"会静默漏跑,而这种漏跑没有任何信号。
 * 重复投递按 dedup_key 冲突处理:encounter_suggest 刷新 next_attempt_at,其余忽略。
 */
export async function enqueue(
  tx: Tx,
  args: { kind: AiJobKindT; dedupKey: string; documentId?: string | null; personId?: string | null },
): Promise<void> {
  const values = {
    id: uuidv7(),
    kind: args.kind,
    dedupKey: args.dedupKey,
    documentId: args.documentId ?? null,
    personId: args.personId ?? null,
    state: 'pending' as const,
  };
  if (args.kind === 'encounter_suggest') {
    await tx.insert(aiJob).values(values).onConflictDoUpdate({
      target: aiJob.dedupKey,
      set: { nextAttemptAt: sql`now()`, updatedAt: sql`now()` },
    });
  } else {
    await tx.insert(aiJob).values(values).onConflictDoNothing({ target: aiJob.dedupKey });
  }
}

export interface ClaimedJob {
  id: string;
  kind: AiJobKindT;
  documentId: string | null;
  personId: string | null;
  attempt: number;
}

/** 回收僵尸作业:running 且锁太久 → 退回 pending 并 +1 attempt。 */
export async function reclaimZombies(instance: string): Promise<number> {
  const rows = await db
    .update(aiJob)
    .set({
      state: 'pending',
      attempt: sql`${aiJob.attempt} + 1`,
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(aiJob.state, 'running'), lt(aiJob.lockedAt, new Date(Date.now() - ZOMBIE_MS))))
    .returning({ id: aiJob.id });
  if (rows.length) console.warn(`[jobs] ${instance} 回收僵尸作业 ${rows.length} 条`);
  return rows.length;
}

/** 取件:SELECT … FOR UPDATE SKIP LOCKED,同事务内置 running。 */
export async function claim(instance: string, limit: number): Promise<ClaimedJob[]> {
  return db.transaction(async (tx) => {
    const picked = await tx
      .select({ id: aiJob.id, kind: aiJob.kind, documentId: aiJob.documentId, personId: aiJob.personId, attempt: aiJob.attempt })
      .from(aiJob)
      .where(and(eq(aiJob.state, 'pending'), lt(aiJob.nextAttemptAt, new Date())))
      .orderBy(aiJob.nextAttemptAt)
      .limit(limit)
      .for('update', { skipLocked: true });
    if (picked.length === 0) return [];
    await tx
      .update(aiJob)
      .set({ state: 'running', lockedAt: sql`now()`, lockedBy: instance, updatedAt: sql`now()` })
      .where(sql`${aiJob.id} in ${sql.raw(`(${picked.map((p) => `'${p.id}'`).join(',')})`)}`);
    return picked as ClaimedJob[];
  });
}

export interface JobFailure {
  stage: string;
  code: string;
  message: string;
  category?: string | null;
}

/** 终态:done / failed / needs_human / unsupported。**禁止**自动离开终态。 */
export async function finish(
  jobId: string,
  state: Extract<AiJobStateT, 'done' | 'failed' | 'needs_human' | 'unsupported'>,
  extra: { resultKey?: string; error?: JobFailure } = {},
): Promise<void> {
  await db
    .update(aiJob)
    .set({
      state,
      resultKey: extra.resultKey ?? null,
      lastError: extra.error ? { ...extra.error, at: new Date().toISOString() } : null,
      lockedAt: null,
      lockedBy: null,
      updatedAt: sql`now()`,
    })
    .where(eq(aiJob.id, jobId));
}

/** 可重试失败:退回 pending 并按全抖动退避;超过 MAX_ATTEMPT 转 failed。 */
export async function retryLater(jobId: string, attempt: number, error: JobFailure): Promise<void> {
  const next = attempt + 1;
  if (next > MAX_ATTEMPT) {
    await finish(jobId, 'failed', { error });
    return;
  }
  await db
    .update(aiJob)
    .set({
      state: 'pending',
      attempt: next,
      nextAttemptAt: new Date(Date.now() + backoffMs(next)),
      lastError: { ...error, at: new Date().toISOString() },
      lockedAt: null,
      lockedBy: null,
      updatedAt: sql`now()`,
    })
    .where(eq(aiJob.id, jobId));
}

/** 显式重跑(m2-04 §5.2):置回 pending、attempt 归零。**不删旧工件** ——
 *  不同 prompt_version 的工件并存,那是"换了 prompt 之后能对比两批产出"的唯一手段。 */
export async function resetForRerun(jobId: string): Promise<void> {
  await db
    .update(aiJob)
    .set({
      state: 'pending', attempt: 0, nextAttemptAt: sql`now()`,
      lastError: null, lockedAt: null, lockedBy: null, updatedAt: sql`now()`,
    })
    .where(eq(aiJob.id, jobId));
}

export const jobsInternals = { MAX_ATTEMPT, ZOMBIE_MS, isNull, or };
