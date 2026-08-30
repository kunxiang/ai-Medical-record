import { startupProbe } from './s3.js';
import { runExportWorker } from './workers/export-worker.js';
import { sqlClient } from './db/client.js';

await startupProbe();
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
console.log('export worker started');
try {
  await runExportWorker(controller.signal);
} finally {
  await sqlClient.end();
}
