import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runExportWorkerOnce } from '../exports/jobs.js';

export async function runExportWorker(signal?: AbortSignal): Promise<void> {
  const instance = `export-${process.pid}-${randomUUID()}`;
  while (!signal?.aborted) {
    const processed = await runExportWorkerOnce(instance);
    if (processed === 0) await delay(500, undefined, { signal }).catch(() => undefined);
  }
}
