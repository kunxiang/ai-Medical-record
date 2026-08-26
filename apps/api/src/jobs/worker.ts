import { env } from '../env.js';
import { claim, finish, reclaimZombies, retryLater, type ClaimedJob } from './queue.js';
import { handleStage1, Stage1Failure } from './stage1-handler.js';
import { FacilityJobFailure, handleFacilityNormalize } from '../normalization/facility-service.js';
import { EncounterJobFailure, handleEncounterSuggest } from '../normalization/encounter-service.js';

// spec m2-04 §3。前台驱动之外的另一半:服务端轮询器。

const POLL_MS = 3_000;
const ZOMBIE_SWEEP_MS = 60_000;

let running = false;
let timer: NodeJS.Timeout | null = null;
let sweeper: NodeJS.Timeout | null = null;

/** 供验收注入:统计每轮处理了几条 */
export const workerStats = { processed: 0, failed: 0 };

async function runOne(job: ClaimedJob): Promise<void> {
  try {
    if (job.kind === 'stage1') {
      if (!job.documentId) {
        await finish(job.id, 'failed', { error: { stage: 'claim', code: 'missing_document', message: 'stage1 作业缺 document_id' } });
        return;
      }
      const { resultKey } = await handleStage1(job.documentId);
      await finish(job.id, 'done', { resultKey });
      workerStats.processed += 1;
      return;
    }
    if (job.kind === 'facility_normalize') {
      await handleFacilityNormalize(job.dedupKey);
      await finish(job.id, 'done');
      workerStats.processed += 1;
      return;
    }
    if (!job.personId) {
      await finish(job.id, 'failed', {
        error: { stage: 'claim', code: 'missing_person', message: 'encounter_suggest 作业缺 person_id' },
      });
      return;
    }
    await handleEncounterSuggest(job.personId);
    await finish(job.id, 'done');
    workerStats.processed += 1;
  } catch (e) {
    workerStats.failed += 1;
    if (e instanceof Stage1Failure && e.terminal) {
      await finish(job.id, e.terminal, { error: e.detail });
      return;
    }
    if (e instanceof FacilityJobFailure) {
      await finish(job.id, e.terminal, { error: e.detail });
      return;
    }
    if (e instanceof EncounterJobFailure) {
      await finish(job.id, e.terminal, { error: e.detail });
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    await retryLater(job.id, job.attempt, { stage: 'run', code: 'unhandled', message: message.slice(0, 900) });
  }
}

async function tick(instance: string, concurrency: number): Promise<void> {
  if (running) return;
  running = true;
  try {
    const jobs = await claim(instance, concurrency);
    if (jobs.length === 0) return;
    // 并发度由 claim 的 limit 控制;这里一批内并行
    await Promise.all(jobs.map(runOne));
  } catch (e) {
    console.error('[jobs] tick 失败:', e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

export function startWorker(instance: string): () => void {
  const concurrency = Math.max(1, Number(env.aiJobConcurrency ?? 2));
  timer = setInterval(() => void tick(instance, concurrency), POLL_MS);
  sweeper = setInterval(() => void reclaimZombies(instance), ZOMBIE_SWEEP_MS);
  console.log(`[jobs] worker 启动 instance=${instance} concurrency=${concurrency}`);
  return () => {
    if (timer) clearInterval(timer);
    if (sweeper) clearInterval(sweeper);
  };
}

/** 供验收同步驱动一轮(与 m1 的 __amr.runQueue 同构) */
export async function tickOnce(instance = 'test', concurrency = 4): Promise<void> {
  await tick(instance, concurrency);
}
