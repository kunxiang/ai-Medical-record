import { env } from './env.js';
import { startWorker as startLegacyDrainWorker } from './jobs/worker.js';
import { startProcessingWorker } from './processing/worker.js';
import { startupProbe } from './s3.js';

if (env.processingMode !== 'assist') {
  throw new Error('plugin worker 只允许在 PROCESSING_MODE=assist 时启动');
}

await startupProbe();
const instance = process.env.INSTANCE_ID ?? `plugin-${process.pid}`;
startProcessingWorker({
  instance,
  pluginId: process.env.PROCESSING_PLUGIN_ID ?? 'legacy-ai',
  pluginVersion: process.env.PROCESSING_PLUGIN_VERSION ?? 'm2-v1',
  concurrency: Math.max(1, env.aiJobConcurrency),
});

// 兼容窗口只 drain 既有 ai_job；所有新触发都进入 processing_job。
if (process.env.AI_LEGACY_DRAIN !== '0') startLegacyDrainWorker(`${instance}-legacy-drain`);

console.log(`plugin worker running instance=${instance}`);
await new Promise<never>(() => {});
