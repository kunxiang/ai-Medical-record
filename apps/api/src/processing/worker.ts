import type { ProcessingCapabilityT } from '@amr/contracts';
import { handleStage1, Stage1Failure } from '../jobs/stage1-handler.js';
import { handleEncounterSuggest, EncounterJobFailure } from '../normalization/encounter-service.js';
import { handleFacilityNormalize, FacilityJobFailure } from '../normalization/facility-service.js';
import { backfillDocumentProcessing } from './backfill.js';
import { DEFAULT_PROCESSING_LEASE_MS } from './constants.js';
import {
  claimProcessingJobs, finishProcessingJob, reclaimExpiredProcessingJobs,
  recordPluginHeartbeat, retryProcessingJob, type ClaimedProcessingJob,
} from './queue.js';

const POLL_MS = 3_000;
const HEARTBEAT_MS = 30_000;
const RECLAIM_MS = 60_000;
const BACKFILL_MS = 5 * 60_000;

export const LEGACY_PLUGIN_CAPABILITIES = [
  'document_metadata_suggest', 'facility_suggest', 'encounter_suggest',
] as const satisfies readonly ProcessingCapabilityT[];

async function runOne(job: ClaimedProcessingJob, input: {
  instance: string; pluginId: string; pluginVersion: string;
}): Promise<void> {
  try {
    if (job.capability === 'document_metadata_suggest') {
      const { resultKey } = await handleStage1(job.subjectId, {
        pluginId: input.pluginId, pluginVersion: input.pluginVersion,
        inputRevision: job.inputRevision, inputSha256: job.inputSha256,
      });
      await finishProcessingJob({ id: job.id, instance: input.instance, state: 'done', resultKey });
      return;
    }
    if (job.capability === 'facility_suggest') {
      await handleFacilityNormalize(job.subjectId);
      await finishProcessingJob({ id: job.id, instance: input.instance, state: 'done' });
      return;
    }
    if (job.capability === 'encounter_suggest') {
      await handleEncounterSuggest(job.subjectId);
      await finishProcessingJob({ id: job.id, instance: input.instance, state: 'done' });
      return;
    }
    await finishProcessingJob({ id: job.id, instance: input.instance, state: 'unsupported' });
  } catch (error) {
    if (error instanceof Stage1Failure || error instanceof FacilityJobFailure
        || error instanceof EncounterJobFailure) {
      if (error instanceof Stage1Failure && error.terminal === null) {
        await retryProcessingJob({ id: job.id, instance: input.instance, error: { ...error.detail } });
      } else {
        await finishProcessingJob({
          id: job.id,
          instance: input.instance,
          state: error.terminal ?? 'failed',
          error: { ...error.detail },
        });
      }
      return;
    }
    await retryProcessingJob({
      id: job.id, instance: input.instance,
      error: {
        stage: 'run', code: 'unhandled',
        message: error instanceof Error ? error.message.slice(0, 900) : String(error).slice(0, 900),
      },
    });
  }
}

export function startProcessingWorker(input: {
  instance: string;
  pluginId: string;
  pluginVersion: string;
  concurrency: number;
}): () => void {
  let ticking = false;
  const heartbeat = () => recordPluginHeartbeat({
    pluginId: input.pluginId,
    pluginVersion: input.pluginVersion,
    capabilities: [...LEGACY_PLUGIN_CAPABILITIES],
    metadata: { runtime: 'amr-plugin-worker' },
  }).catch((error) => console.error('[processing] heartbeat 失败:', error));
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const jobs = await claimProcessingJobs({
        instance: input.instance,
        pluginId: input.pluginId,
        pluginVersion: input.pluginVersion,
        capabilities: [...LEGACY_PLUGIN_CAPABILITIES],
        limit: Math.max(1, input.concurrency),
        leaseMs: DEFAULT_PROCESSING_LEASE_MS,
      });
      await Promise.all(jobs.map((job) => runOne(job, {
        instance: input.instance, pluginId: input.pluginId, pluginVersion: input.pluginVersion,
      })));
    } catch (error) {
      console.error('[processing] tick 失败:', error);
    } finally {
      ticking = false;
    }
  };
  const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  const pollTimer = setInterval(() => void tick(), POLL_MS);
  const reclaimTimer = setInterval(
    () => void reclaimExpiredProcessingJobs().catch((error) => console.error('[processing] reclaim 失败:', error)),
    RECLAIM_MS,
  );
  const backfill = () => backfillDocumentProcessing()
    .catch((error) => console.error('[processing] backfill 失败:', error));
  // 首次 backfill 必须等待本 worker 的 heartbeat 可见，否则新部署会无故延迟一个周期。
  void heartbeat().then(backfill);
  const backfillTimer = setInterval(backfill, BACKFILL_MS);
  console.log(`[processing] worker 启动 plugin=${input.pluginId}@${input.pluginVersion}`);
  return () => {
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    clearInterval(reclaimTimer);
    clearInterval(backfillTimer);
  };
}

export const processingWorkerInternals = { POLL_MS, HEARTBEAT_MS, RECLAIM_MS, BACKFILL_MS };
