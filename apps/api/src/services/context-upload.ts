import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  ContextMediaSidecar, ContextUpload, ContextUploadFinalizeResponse,
  ContextUploadPresignResponse, ContextUploadSnapshot, ContextUploadViewResponse,
  MULTIPART_PART_BYTES, MULTIPART_THRESHOLD_BYTES,
  type ContextQuestionT, type ContextUploadPrepareRequestT, type ContextUploadT,
  type ContextUploadSnapshotT,
} from '@amr/contracts';
import {
  buildKey, canonicalJson, serverTimestamp, type ContextMediaExtension,
} from '@amr/storage';
import { db, type Tx } from '../db/client.js';
import { contextSession, contextUpload, person } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { appendJournal } from '../journal.js';
import {
  multipartPartCount, orderedCompleteParts, sha256Hex, shouldRestartMultipart,
} from '../multipart-planning.js';
import {
  completeMultipartUpload, copyWithLock, createMultipartUpload, deleteObjectIfPossible,
  getObjectBytes, getObjectText, headObject, presignGetKey, presignMultipartPart, presignPut,
  putWorm,
} from '../s3.js';
import { recordOperation, replayOperation } from './operation-ledger.js';

type ContextUploadRow = typeof contextUpload.$inferSelect;

interface ContextMultipartState {
  upload_id: string;
  part_count: number;
  state: 'pending' | 'completed';
}

const MIME_EXT: Record<ContextUploadPrepareRequestT['mime'], ContextMediaExtension> = {
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const hexToBase64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

function multipartState(row: ContextUploadRow): ContextMultipartState | null {
  if (!row.multipartState || typeof row.multipartState !== 'object') return null;
  const value = row.multipartState as Record<string, unknown>;
  if (typeof value.upload_id !== 'string' || typeof value.part_count !== 'number'
      || (value.state !== 'pending' && value.state !== 'completed')) return null;
  return { upload_id: value.upload_id, part_count: value.part_count, state: value.state };
}

export function contextUploadOut(row: ContextUploadRow): ContextUploadT {
  return ContextUpload.parse({
    id: row.id, person_id: row.personId, session_id: row.sessionId,
    question_key: row.questionKey, kind: row.kind, mime: row.mime,
    byte_size: row.byteSize, sha256: row.sha256, state: row.state,
    created_at: row.createdAt.toISOString(), finalized_at: row.finalizedAt?.toISOString() ?? null,
  });
}

function contextUploadSnapshot(row: ContextUploadRow): ContextUploadSnapshotT {
  return ContextUploadSnapshot.parse({
    ...contextUploadOut(row), object_key: row.objectKey,
    multipart_state: row.multipartState, created_by: row.createdBy,
  });
}

async function lockOwnedUpload(tx: Tx, uploadId: string, accountId: string): Promise<ContextUploadRow> {
  const row = (await tx.select().from(contextUpload).where(and(
    eq(contextUpload.id, uploadId), eq(contextUpload.createdBy, accountId),
  )).limit(1).for('update'))[0];
  if (!row) throw notFound();
  return row;
}

export async function contextUploadPersonId(uploadId: string): Promise<string> {
  const row = (await db.select({ personId: contextUpload.personId }).from(contextUpload)
    .where(eq(contextUpload.id, uploadId)).limit(1))[0];
  if (!row) throw notFound();
  return row.personId;
}

export async function prepareContextUpload(input: {
  accountId: string; body: ContextUploadPrepareRequestT;
}) {
  return db.transaction(async (tx) => {
    const session = (await tx.select().from(contextSession)
      .where(eq(contextSession.id, input.body.session_id)).limit(1).for('update'))[0];
    if (!session || session.personId !== input.body.person_id || session.status !== 'active') throw notFound();
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, session.personId)).limit(1))[0];
    if (!owner) throw notFound();
    const question = (session.questionSnapshot as ContextQuestionT[])
      .find((candidate) => candidate.key === input.body.question_key);
    if (!question || question.answer_type !== input.body.kind) {
      throw new ApiError('validation_failed', '媒体类型与 session 问题不匹配');
    }
    const replay = await replayOperation<ContextUploadT>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request: input.body,
    });
    if (replay.result) return ContextUpload.parse(replay.result);
    const id = uuidv7();
    const objectKey = buildKey.contextMedia({
      personSlug: owner.slug, sessionId: session.id, questionKey: question.key,
      uploadId: id, ext: MIME_EXT[input.body.mime],
    });
    const row = (await tx.insert(contextUpload).values({
      id, personId: session.personId, sessionId: session.id, questionKey: question.key,
      kind: input.body.kind, mime: input.body.mime, byteSize: input.body.byte_size,
      sha256: input.body.sha256, objectKey, state: 'prepared', multipartState: null,
      createdBy: input.accountId,
    }).returning())[0]!;
    const response = contextUploadOut(row);
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'context_upload_prepare', subjectType: 'context_upload', subjectId: row.id,
      personId: row.personId, requestHash: replay.requestHash, request: input.body, result: response,
    });
    return response;
  });
}

export async function presignContextUpload(uploadId: string, accountId: string) {
  return db.transaction(async (tx) => {
    const current = await lockOwnedUpload(tx, uploadId, accountId);
    if (current.state === 'finalized' || current.state === 'expired') {
      throw new ApiError('validation_failed', '该媒体上传已结束');
    }
    const incomingKey = buildKey.incoming({ batchId: current.sessionId, uploadId: current.id });
    const expiresAt = new Date(Date.now() + 900_000).toISOString();
    if (current.byteSize <= MULTIPART_THRESHOLD_BYTES) {
      const signed = await presignPut(incomingKey, current.mime, hexToBase64(current.sha256));
      const row = (await tx.update(contextUpload).set({ state: 'uploading' })
        .where(eq(contextUpload.id, current.id)).returning())[0]!;
      return ContextUploadPresignResponse.parse({
        upload: contextUploadOut(row), mode: 'single', method: 'PUT',
        url: signed.url, headers: signed.headers, expires_at: expiresAt,
        part_size: null, part_count: null, parts: [],
      });
    }
    let state = multipartState(current);
    if (!state) {
      const s3UploadId = await createMultipartUpload(incomingKey, current.mime);
      state = { upload_id: s3UploadId, part_count: multipartPartCount(current.byteSize), state: 'pending' };
    }
    if (state.state !== 'pending') throw new ApiError('validation_failed', 'multipart 上传已经完成');
    const parts = await Promise.all(Array.from({ length: state.part_count }, async (_, index) => ({
      part_number: index + 1,
      url: await presignMultipartPart(incomingKey, state!.upload_id, index + 1),
    })));
    const row = (await tx.update(contextUpload).set({ state: 'uploading', multipartState: state })
      .where(eq(contextUpload.id, current.id)).returning())[0]!;
    return ContextUploadPresignResponse.parse({
      upload: contextUploadOut(row), mode: 'multipart', method: 'PUT', url: null, headers: {},
      expires_at: expiresAt, part_size: MULTIPART_PART_BYTES, part_count: state.part_count, parts,
    });
  });
}

async function verifiedIncomingBytes(row: ContextUploadRow, parts: Array<{ part_number: number; etag: string }>) {
  const incomingKey = buildKey.incoming({ batchId: row.sessionId, uploadId: row.id });
  const state = multipartState(row);
  let bytes: Buffer | null = null;
  if (row.byteSize > MULTIPART_THRESHOLD_BYTES) {
    if (!state || state.state !== 'pending') throw new ApiError('upload_incomplete', 'multipart 尚未建立或已经失效');
    let ordered;
    try {
      ordered = orderedCompleteParts(parts, state.part_count);
    } catch {
      throw new ApiError('validation_failed', '必须提交从 1 开始的完整连续分片清单');
    }
    try {
      await completeMultipartUpload(
        incomingKey, state.upload_id,
        ordered.map((part) => ({ partNumber: part.part_number, etag: part.etag })),
      );
    } catch (error) {
      bytes = await getObjectBytes(incomingKey);
      const recovered = bytes !== null && bytes.length === row.byteSize && sha256Hex(bytes) === row.sha256;
      if (!recovered) {
        if (shouldRestartMultipart(error)) {
          throw new ApiError('upload_incomplete', 'multipart 已失效，请重新准备媒体上传');
        }
        throw error;
      }
    }
  } else if (parts.length > 0) {
    throw new ApiError('validation_failed', '单 PUT 上传不得提交 multipart parts');
  }
  bytes ??= await getObjectBytes(incomingKey);
  if (!bytes || bytes.length !== row.byteSize) throw new ApiError('upload_incomplete', '媒体对象不存在或大小不一致');
  if (sha256Hex(bytes) !== row.sha256) throw new ApiError('sha256_mismatch', '媒体对象 SHA-256 不一致');
  const head = await headObject(incomingKey);
  if (!head || head.contentType !== row.mime) throw new ApiError('unsupported_media_type', '媒体对象 MIME 与声明不一致');
  return { bytes, incomingKey };
}

async function ensureFinalMedia(row: ContextUploadRow, incomingKey: string, bytes: Buffer): Promise<void> {
  const final = await getObjectBytes(row.objectKey);
  if (final) {
    if (final.length !== row.byteSize || createHash('sha256').update(final).digest('hex') !== row.sha256) {
      throw new ApiError('internal_error', 'Context L1 key 已存在但内容不一致');
    }
    return;
  }
  if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
    throw new ApiError('sha256_mismatch', '媒体对象 SHA-256 不一致');
  }
  await copyWithLock(incomingKey, row.objectKey, row.mime);
}

async function putSidecarIdempotent(key: string, body: Buffer): Promise<void> {
  const result = await putWorm(key, body, 'application/json');
  if (result === 'created') return;
  const existing = await getObjectText(key);
  if (!existing || existing.text !== body.toString('utf8')) {
    throw new ApiError('internal_error', 'Context 媒体 sidecar 已存在但内容不一致');
  }
}

export async function finalizeContextUpload(input: {
  uploadId: string; accountId: string;
  body: { client_operation_id: string; parts: Array<{ part_number: number; etag: string }> };
}) {
  let cleanupKey: string | null = null;
  const response = await db.transaction(async (tx) => {
    const current = await lockOwnedUpload(tx, input.uploadId, input.accountId);
    const session = (await tx.select().from(contextSession)
      .where(eq(contextSession.id, current.sessionId)).limit(1).for('update'))[0];
    if (!session || session.personId !== current.personId) throw notFound();
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, current.personId)).limit(1))[0];
    if (!owner) throw notFound();
    const request = { upload_id: input.uploadId, ...input.body };
    const replay = await replayOperation<ReturnType<typeof ContextUploadFinalizeResponse.parse>>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return ContextUploadFinalizeResponse.parse(replay.result);
    if (current.state === 'finalized') {
      return ContextUploadFinalizeResponse.parse({ upload: contextUploadOut(current) });
    }
    const verified = await verifiedIncomingBytes(current, input.body.parts);
    cleanupKey = verified.incomingKey;
    await ensureFinalMedia(current, verified.incomingKey, verified.bytes);
    const question = (session.questionSnapshot as ContextQuestionT[])
      .find((candidate) => candidate.key === current.questionKey);
    if (!question || question.answer_type !== current.kind) throw notFound();
    const at = serverTimestamp();
    const nextMultipart = multipartState(current)
      ? { ...multipartState(current)!, state: 'completed' as const } : null;
    const row = (await tx.update(contextUpload).set({
      state: 'finalized', finalizedAt: new Date(at), multipartState: nextMultipart,
    }).where(eq(contextUpload.id, current.id)).returning())[0]!;
    const sidecar = ContextMediaSidecar.parse({
      schema_version: '1.0', upload_id: row.id, person_id: row.personId, person_slug: owner.slug,
      session_id: row.sessionId, question_key: row.questionKey, question_text: question.text,
      template_id: session.templateId, template_version: session.templateVersion,
      template_hash: session.templateHash, kind: row.kind, mime: row.mime,
      byte_size: row.byteSize, sha256: row.sha256, object_key: row.objectKey,
      created_by: row.createdBy, created_at: row.createdAt.toISOString(), finalized_at: at,
    });
    const sidecarKey = buildKey.contextMediaMeta({
      personSlug: owner.slug, sessionId: row.sessionId, questionKey: row.questionKey, uploadId: row.id,
    });
    await putSidecarIdempotent(sidecarKey, canonicalJson(sidecar));
    const result = ContextUploadFinalizeResponse.parse({ upload: contextUploadOut(row) });
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'context_media_finalize', subjectType: 'context_upload', subjectId: row.id,
      personId: row.personId, requestHash: replay.requestHash, request, result,
    });
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'context_media_finalize',
      event_id: input.body.client_operation_id, at, by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: owner.slug,
      subject_id: row.id, revision: 1, before: null, after: contextUploadSnapshot(row),
      operation_replay: { request_hash: replay.requestHash, response_snapshot: result }, references: {},
    });
    return result;
  });
  if (cleanupKey) await deleteObjectIfPossible(cleanupKey);
  return response;
}

export async function viewContextUpload(uploadId: string) {
  const row = (await db.select().from(contextUpload)
    .where(eq(contextUpload.id, uploadId)).limit(1))[0];
  if (!row || row.state !== 'finalized') throw notFound();
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  return ContextUploadViewResponse.parse({
    upload: contextUploadOut(row), url: await presignGetKey(row.objectKey, 300), expires_at: expiresAt,
  });
}
