import { and, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  ExportInputManifest, ExportJob, ExportSelection, canonicalJsonString,
  type ExportJobT, type ExportListQueryT, type VisitSummaryCreateRequestT,
} from '@amr/contracts';
import { createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { exportJob } from '../db/schema.js';
import { env } from '../env.js';
import { ApiError, notFound } from '../errors.js';
import { getObjectBytes, headObject, putRewritable } from '../s3.js';
import { recordOperation, replayOperation } from '../services/operation-ledger.js';
import { buildExportInput, buildExportPreview, isExportTooLarge } from './canonical-input.js';
import { renderVisitSummary } from './renderer.js';

type ExportRow = typeof exportJob.$inferSelect;
type LastError = { code: string; message: string };

function selectionFromCreate(body: VisitSummaryCreateRequestT) {
  const { client_operation_id: _operation, ...selection } = body;
  return ExportSelection.parse(selection);
}

async function currentState(row: ExportRow): Promise<{ stale: boolean; artifactAvailable: boolean }> {
  const [preview, head] = await Promise.all([
    buildExportPreview(ExportSelection.parse(row.request)),
    row.resultKey ? headObject(row.resultKey) : Promise.resolve(null),
  ]);
  return {
    stale: preview.source_revision_hash !== row.sourceRevisionHash,
    artifactAvailable: row.state === 'done' && head !== null,
  };
}

export async function exportJobOut(row: ExportRow): Promise<ExportJobT> {
  const current = await currentState(row);
  return ExportJob.parse({
    id: row.id, person_id: row.personId, kind: row.kind, request: row.request,
    state: row.state, attempt: row.attempt, max_attempts: row.maxAttempts,
    progress: row.progress, last_error: row.lastError,
    renderer_id: row.rendererId, renderer_version: row.rendererVersion,
    font_manifest_hash: row.fontManifestHash, result_sha256: row.resultSha256,
    result_byte_size: row.resultByteSize, result_content_hash: row.resultContentHash,
    artifact_available: current.artifactAvailable, snapshot_at: row.snapshotAt.toISOString(),
    source_revision_hash: row.sourceRevisionHash, stale: current.stale,
    created_by: row.createdBy, created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(), completed_at: row.completedAt?.toISOString() ?? null,
  });
}

export async function getExportRow(id: string): Promise<ExportRow> {
  const row = (await db.select().from(exportJob).where(eq(exportJob.id, id)).limit(1))[0];
  if (!row) throw notFound();
  return row;
}

export async function createVisitSummaryJob(input: {
  accountId: string; body: VisitSummaryCreateRequestT;
}): Promise<ExportJobT> {
  const selection = selectionFromCreate(input.body);
  const request = { kind: 'visit_summary', selection };
  const result = await db.transaction(async (tx) => {
    const replay = await replayOperation<{ job_id: string }>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return replay.result.job_id;
    const preview = await buildExportPreview(selection);
    if (preview.metrics.length === 0 && preview.events.length === 0) {
      throw new ApiError('export_has_no_confirmed_data', '所选范围没有可导出的已确认事实', {
        counts: preview.counts, gaps: preview.gaps,
      });
    }
    if (isExportTooLarge(preview)) {
      throw new ApiError('export_too_large', '原件附录超过导出上限', {
        original_bytes_estimate: preview.original_bytes_estimate,
        original_pages: preview.counts.original_pages,
        max_bytes: env.exports.maxOriginalBytes, max_pages: env.exports.maxOriginalPages,
        suggestions: ['缩小日期范围', '取消原件附录', '改用单人 L1 bundle'],
      });
    }
    if (!preview.can_generate) {
      throw new ApiError('validation_failed', '当前格式无法生成所选附录', { gaps: preview.gaps });
    }
    const manifest = await buildExportInput(selection);
    const now = new Date();
    const id = uuidv7();
    await tx.insert(exportJob).values({
      id, personId: selection.person_id, kind: 'visit_summary',
      clientOperationId: input.body.client_operation_id, request: selection,
      requestHash: createHash('sha256').update(canonicalJsonString(selection)).digest('hex'),
      sourceRevisionHash: manifest.source_revision_hash, snapshotAt: now, inputManifest: manifest,
      state: 'pending', attempt: 0, maxAttempts: 5, nextAttemptAt: now, progress: 0,
      rendererId: manifest.renderer_id, rendererVersion: manifest.renderer_version,
      fontManifestHash: manifest.font_manifest_hash, createdBy: input.accountId,
      createdAt: now, updatedAt: now,
    });
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'export_create', subjectType: 'export', subjectId: id, personId: selection.person_id,
      requestHash: replay.requestHash, request, result: { job_id: id },
    });
    return id;
  });
  return exportJobOut(await getExportRow(result));
}

type ExportCursor = { created_at: string; id: string };
function decodeCursor(value: string): ExportCursor {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as ExportCursor;
    if (typeof cursor.id !== 'string' || Number.isNaN(Date.parse(cursor.created_at))) throw new Error();
    return cursor;
  } catch { throw new ApiError('validation_failed', '导出游标无效'); }
}

export async function listExports(input: ExportListQueryT, role: 'viewer' | 'editor' | 'owner') {
  const conditions = [eq(exportJob.personId, input.person_id)];
  if (role === 'viewer') conditions.push(eq(exportJob.state, 'done'));
  else if (input.state) conditions.push(eq(exportJob.state, input.state));
  if (input.kind) conditions.push(eq(exportJob.kind, input.kind));
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    conditions.push(or(
      lt(exportJob.createdAt, new Date(cursor.created_at)),
      and(eq(exportJob.createdAt, new Date(cursor.created_at)), lt(exportJob.id, cursor.id)),
    )!);
  }
  const rows = await db.select().from(exportJob).where(and(...conditions))
    .orderBy(desc(exportJob.createdAt), desc(exportJob.id)).limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    access_role: role,
    exports: await Promise.all(page.map(exportJobOut)),
    next_cursor: rows.length > input.limit && last ? Buffer.from(JSON.stringify({
      created_at: last.createdAt.toISOString(), id: last.id,
    })).toString('base64url') : null,
  };
}

export async function retryExportJob(input: {
  jobId: string; accountId: string; clientOperationId: string;
}): Promise<ExportJobT> {
  const row = await db.transaction(async (tx) => {
    const current = (await tx.select().from(exportJob).where(eq(exportJob.id, input.jobId))
      .limit(1).for('update'))[0];
    if (!current) throw notFound();
    const request = { export_job_id: input.jobId, retry: true };
    const replay = await replayOperation<{ job_id: string }>(tx, {
      accountId: input.accountId, clientOperationId: input.clientOperationId, request,
    });
    if (replay.result) return current;
    const now = new Date();
    const updated = (await tx.update(exportJob).set({
      state: 'pending', nextAttemptAt: now, lockedAt: null, lockedBy: null,
      leaseExpiresAt: null, progress: 0, lastError: null,
      maxAttempts: Math.max(current.maxAttempts, current.attempt + 5), updatedAt: now,
    }).where(eq(exportJob.id, current.id)).returning())[0]!;
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.clientOperationId,
      kind: 'export_retry', subjectType: 'export', subjectId: current.id,
      personId: current.personId, requestHash: replay.requestHash, request,
      result: { job_id: current.id },
    });
    return updated;
  });
  return exportJobOut(row);
}

export interface ClaimedExportJob { id: string; attempt: number; manifest: unknown }

export async function claimExportJobs(instance: string, limit: number): Promise<ClaimedExportJob[]> {
  if (limit < 1) return [];
  return db.transaction(async (tx) => {
    const rows = await tx.select({
      id: exportJob.id, attempt: exportJob.attempt, manifest: exportJob.inputManifest,
    }).from(exportJob).where(and(
      eq(exportJob.state, 'pending'), lte(exportJob.nextAttemptAt, new Date()),
    )).orderBy(exportJob.nextAttemptAt, exportJob.id).limit(limit).for('update', { skipLocked: true });
    if (rows.length === 0) return [];
    const now = new Date();
    await tx.update(exportJob).set({
      state: 'running', lockedAt: now, lockedBy: instance,
      leaseExpiresAt: new Date(now.getTime() + env.exports.leaseMs), progress: 10, updatedAt: now,
    }).where(inArray(exportJob.id, rows.map((row) => row.id)));
    return rows;
  });
}

export async function reclaimExpiredExportJobs(now = new Date()): Promise<number> {
  const rows = await db.update(exportJob).set({
    state: sql`case when ${exportJob.attempt} + 1 >= ${exportJob.maxAttempts} then 'failed' else 'pending' end`,
    attempt: sql`${exportJob.attempt} + 1`, nextAttemptAt: now,
    lockedAt: null, lockedBy: null, leaseExpiresAt: null, progress: 0,
    lastError: { code: 'lease_expired', message: 'worker lease 已过期，任务已回收' }, updatedAt: now,
  }).where(and(eq(exportJob.state, 'running'), lt(exportJob.leaseExpiresAt, now)))
    .returning({ id: exportJob.id });
  return rows.length;
}

async function failClaimedJob(row: ClaimedExportJob, instance: string, error: unknown): Promise<void> {
  const nextAttempt = row.attempt + 1;
  const message = error instanceof Error ? error.message : String(error);
  const failure: LastError = { code: message.split(':')[0] || 'render_failed', message: message.slice(0, 500) };
  await db.update(exportJob).set({
    state: sql`case when ${nextAttempt} >= ${exportJob.maxAttempts} then 'failed' else 'pending' end`,
    attempt: nextAttempt, nextAttemptAt: new Date(Date.now() + Math.min(2 ** nextAttempt * 1_000, 60_000)),
    lockedAt: null, lockedBy: null, leaseExpiresAt: null, progress: 0,
    lastError: failure, updatedAt: new Date(),
  }).where(and(eq(exportJob.id, row.id), eq(exportJob.lockedBy, instance)));
}

export async function processClaimedExportJob(row: ClaimedExportJob, instance: string): Promise<void> {
  try {
    const manifest = ExportInputManifest.parse(row.manifest);
    const rendered = await renderVisitSummary(manifest, getObjectBytes);
    const key = `derived/exports/${manifest.person.id}/${row.id}/visit-summary.${rendered.extension}`;
    await putRewritable(key, rendered.bytes, rendered.contentType);
    const now = new Date();
    await db.update(exportJob).set({
      state: 'done', progress: 100, resultKey: key, resultSha256: rendered.sha256,
      resultByteSize: rendered.bytes.length, resultContentHash: rendered.contentHash,
      completedAt: now, updatedAt: now, lockedAt: null, lockedBy: null, leaseExpiresAt: null,
      lastError: null,
    }).where(and(eq(exportJob.id, row.id), eq(exportJob.lockedBy, instance)));
  } catch (error) { await failClaimedJob(row, instance, error); }
}

export async function runExportWorkerOnce(instance: string, limit = env.exports.workerConcurrency): Promise<number> {
  await reclaimExpiredExportJobs();
  const jobs = await claimExportJobs(instance, limit);
  await Promise.all(jobs.map((job) => processClaimedExportJob(job, instance)));
  return jobs.length;
}
