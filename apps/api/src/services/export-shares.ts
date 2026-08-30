import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  ExportShare, ExportShareCreateResponse,
  type ExportShareCreateRequestT, type ExportShareCreateResponseT, type ExportShareT,
} from '@amr/contracts';
import type { Readable } from 'node:stream';
import { db } from '../db/client.js';
import { exportJob, exportShare } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { getObjectStream } from '../s3.js';
import { exportShareTokenHash, newExportShareToken } from '../exports/share-token.js';
import { recordOperation, replayOperation } from './operation-ledger.js';

type ShareRow = typeof exportShare.$inferSelect;

function shareOut(row: ShareRow): ExportShareT {
  return ExportShare.parse({
    id: row.id, export_job_id: row.exportJobId, expires_at: row.expiresAt.toISOString(),
    created_by: row.createdBy, created_at: row.createdAt.toISOString(),
    revoked_at: row.revokedAt?.toISOString() ?? null,
    last_accessed_at: row.lastAccessedAt?.toISOString() ?? null,
    access_count: row.accessCount,
  });
}

async function shareById(id: string): Promise<ShareRow> {
  const row = (await db.select().from(exportShare).where(eq(exportShare.id, id)).limit(1))[0];
  if (!row) throw notFound();
  return row;
}

export async function createExportShare(input: {
  exportJobId: string; accountId: string; body: ExportShareCreateRequestT;
}): Promise<ExportShareCreateResponseT> {
  const job = (await db.select().from(exportJob).where(eq(exportJob.id, input.exportJobId)).limit(1))[0];
  if (!job || job.state !== 'done' || !job.resultKey) throw notFound();
  if (job.sourceRevisionHash !== input.body.source_revision_hash) {
    throw new ApiError('revision_conflict', '导出版本已变化，请重新确认分享范围', {
      base_revision: input.body.source_revision_hash,
      current: job.sourceRevisionHash,
      draft: input.body.source_revision_hash,
    });
  }
  const request = {
    export_job_id: input.exportJobId,
    expires_in_seconds: input.body.expires_in_seconds,
    source_revision_hash: input.body.source_revision_hash,
    confirmed: true,
  };
  const result = await db.transaction(async (tx) => {
    const replay = await replayOperation<{ share_id: string }>(tx, {
      accountId: input.accountId,
      clientOperationId: input.body.client_operation_id,
      request,
    });
    if (replay.result) return { shareId: replay.result.share_id, token: null };
    const token = newExportShareToken();
    const now = new Date();
    const shareId = randomUUID();
    await tx.insert(exportShare).values({
      id: shareId, exportJobId: input.exportJobId, tokenHash: exportShareTokenHash(token),
      expiresAt: new Date(now.getTime() + input.body.expires_in_seconds * 1_000),
      createdBy: input.accountId, clientOperationId: input.body.client_operation_id,
      requestHash: replay.requestHash, createdAt: now,
    });
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'export_share_create', subjectType: 'share', subjectId: shareId,
      personId: job.personId, requestHash: replay.requestHash, request,
      result: { share_id: shareId },
    });
    return { shareId, token };
  });
  return ExportShareCreateResponse.parse({
    share: shareOut(await shareById(result.shareId)),
    token: result.token,
    token_recoverable: false,
  });
}

export async function listExportShares(exportJobId: string): Promise<{ shares: ExportShareT[] }> {
  const rows = await db.select().from(exportShare).where(eq(exportShare.exportJobId, exportJobId))
    .orderBy(desc(exportShare.createdAt), desc(exportShare.id));
  return { shares: rows.map(shareOut) };
}

export async function revokeExportShare(input: {
  exportJobId: string; shareId: string; accountId: string; clientOperationId: string;
}): Promise<ExportShareT> {
  const row = await db.transaction(async (tx) => {
    const current = (await tx.select().from(exportShare).where(and(
      eq(exportShare.id, input.shareId), eq(exportShare.exportJobId, input.exportJobId),
    )).limit(1).for('update'))[0];
    if (!current) throw notFound();
    const request = { export_job_id: input.exportJobId, share_id: input.shareId, revoke: true };
    const replay = await replayOperation<{ share_id: string }>(tx, {
      accountId: input.accountId, clientOperationId: input.clientOperationId, request,
    });
    if (replay.result) return current;
    const updated = current.revokedAt ? current : (await tx.update(exportShare).set({
      revokedAt: new Date(),
    }).where(eq(exportShare.id, current.id)).returning())[0]!;
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.clientOperationId,
      kind: 'export_share_revoke', subjectType: 'share', subjectId: current.id,
      personId: null, requestHash: replay.requestHash, request,
      result: { share_id: current.id },
    });
    return updated;
  });
  return shareOut(row);
}

interface RateWindow { startedAt: number; count: number }
const publicShareWindows = new Map<string, RateWindow>();
const PUBLIC_SHARE_LIMIT = 10;

function checkPublicShareRate(tokenHash: string, ip: string, now = Date.now()): void {
  if (publicShareWindows.size > 10_000) {
    for (const [key, value] of publicShareWindows) {
      if (now - value.startedAt >= 60_000) publicShareWindows.delete(key);
    }
  }
  const key = `${tokenHash}:${ip}`;
  const current = publicShareWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    publicShareWindows.set(key, { startedAt: now, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > PUBLIC_SHARE_LIMIT) {
    throw new ApiError('share_rate_limited', '公开分享访问过于频繁，请稍后再试');
  }
}

export async function openPublicExportShare(input: {
  token: string; ip: string;
}): Promise<{
  shareId: string; stream: Readable; format: 'pdf' | 'png';
}> {
  const tokenHash = exportShareTokenHash(input.token);
  checkPublicShareRate(tokenHash, input.ip);
  const now = new Date();
  const row = (await db.select({
    shareId: exportShare.id, resultKey: exportJob.resultKey, request: exportJob.request,
  }).from(exportShare).innerJoin(exportJob, eq(exportJob.id, exportShare.exportJobId)).where(and(
    eq(exportShare.tokenHash, tokenHash), isNull(exportShare.revokedAt),
    gt(exportShare.expiresAt, now), eq(exportJob.state, 'done'),
  )).limit(1))[0];
  if (!row?.resultKey) throw notFound();
  const stream = await getObjectStream(row.resultKey);
  if (!stream) throw notFound();
  const touched = await db.update(exportShare).set({
    lastAccessedAt: now,
    accessCount: sql`${exportShare.accessCount} + 1`,
  }).where(and(
    eq(exportShare.id, row.shareId), isNull(exportShare.revokedAt), gt(exportShare.expiresAt, now),
  )).returning({ id: exportShare.id });
  if (touched.length === 0) throw notFound();
  return {
    shareId: row.shareId, stream,
    format: (row.request as { format?: string }).format === 'png' ? 'png' : 'pdf',
  };
}
