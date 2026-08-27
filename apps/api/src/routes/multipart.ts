import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  MULTIPART_PART_BYTES, MULTIPART_THRESHOLD_BYTES, MultipartCompleteRequest,
  MultipartCompleteResponse, MultipartCreateRequest, MultipartCreateResponse,
  MultipartSignRequest, MultipartSignResponse,
} from '@amr/contracts';
import { requirePersonAccess } from '../access.js';
import { db, type Tx } from '../db/client.js';
import { multipartUpload, uploadBatch, uploadFile } from '../db/schema.js';
import { defineRoute } from '../define-route.js';
import { ApiError, notFound } from '../errors.js';
import {
  multipartPartCount, orderedCompleteParts, sha256Hex, shouldRestartMultipart,
} from '../multipart-planning.js';
import {
  completeMultipartUpload, createMultipartUpload, deleteObjectIfPossible, getObjectBytes,
  presignMultipartPart,
} from '../s3.js';

async function ownedFile(uploadFileId: string, accountId: string) {
  const row = (await db.select({
    file: uploadFile, personId: uploadBatch.personId,
    expiresAt: uploadBatch.expiresAt, consumedByDocumentId: uploadBatch.consumedByDocumentId,
  })
    .from(uploadFile).innerJoin(uploadBatch, eq(uploadBatch.id, uploadFile.batchId))
    .where(and(eq(uploadFile.id, uploadFileId), eq(uploadBatch.createdBy, accountId)))
    .limit(1))[0];
  if (!row) throw notFound();
  await requirePersonAccess(accountId, row.personId, 'editor');
  if (row.expiresAt.getTime() < Date.now()) {
    throw new ApiError('upload_incomplete', '上传批次不存在或已过期');
  }
  if (row.consumedByDocumentId) throw new ApiError('upload_consumed', '批次已被文档消费');
  return row.file;
}

async function ownedMultipart(uploadId: string, accountId: string, tx: Tx | typeof db = db) {
  const row = (await tx.select({
    multipart: multipartUpload, file: uploadFile, personId: uploadBatch.personId,
    expiresAt: uploadBatch.expiresAt, consumedByDocumentId: uploadBatch.consumedByDocumentId,
  })
    .from(multipartUpload)
    .innerJoin(uploadFile, eq(uploadFile.id, multipartUpload.uploadFileId))
    .innerJoin(uploadBatch, eq(uploadBatch.id, uploadFile.batchId))
    .where(and(eq(multipartUpload.id, uploadId), eq(uploadBatch.createdBy, accountId)))
    .limit(1))[0];
  if (!row) throw notFound();
  return row;
}

export function registerMultipartRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'POST', url: '/api/v1/uploads/multipart/create',
    input: MultipartCreateRequest, output: MultipartCreateResponse, status: 201,
    handler: async ({ input, accountId }) => {
      const file = await ownedFile(input.upload_file_id, accountId);
      if (file.byteSize <= MULTIPART_THRESHOLD_BYTES) {
        throw new ApiError('validation_failed', '不超过 8 MiB 的文件必须使用单 PUT');
      }
      const partCount = multipartPartCount(file.byteSize);
      const uploadId = await createMultipartUpload(file.incomingKey, file.mimeType);
      await db.insert(multipartUpload).values({
        id: uploadId, uploadFileId: file.id, storageKey: file.incomingKey, partCount,
      });
      return MultipartCreateResponse.parse({
        upload_id: uploadId, key: file.incomingKey,
        part_size: MULTIPART_PART_BYTES, part_count: partCount,
      });
    },
  });

  defineRoute(app, {
    method: 'POST', url: '/api/v1/uploads/multipart/sign',
    input: MultipartSignRequest, output: MultipartSignResponse,
    handler: async ({ input, accountId }) => {
      const row = await ownedMultipart(input.upload_id, accountId);
      await requirePersonAccess(accountId, row.personId, 'editor');
      if (row.multipart.state !== 'pending') {
        throw new ApiError('validation_failed', 'multipart 上传已经完成');
      }
      if (row.expiresAt.getTime() < Date.now()) {
        throw new ApiError('upload_incomplete', '上传批次不存在或已过期');
      }
      if (row.consumedByDocumentId) throw new ApiError('upload_consumed', '批次已被文档消费');
      if (input.part_numbers.some((partNumber) => partNumber > row.multipart.partCount)) {
        throw new ApiError('validation_failed', '分片号超过该文件范围');
      }
      const parts = await Promise.all(input.part_numbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await presignMultipartPart(row.multipart.storageKey, input.upload_id, partNumber),
      })));
      return MultipartSignResponse.parse({
        parts, expires_at: new Date(Date.now() + 900_000).toISOString(),
      });
    },
  });

  defineRoute(app, {
    method: 'POST', url: '/api/v1/uploads/multipart/complete',
    input: MultipartCompleteRequest, output: MultipartCompleteResponse,
    handler: async ({ input, accountId }) => db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.upload_id}, 0))`);
      const row = await ownedMultipart(input.upload_id, accountId, tx);
      await requirePersonAccess(accountId, row.personId, 'editor');
      if (row.multipart.state === 'completed') {
        return MultipartCompleteResponse.parse({
          completed: true, byte_size: row.multipart.resultByteSize,
          sha256: row.multipart.resultSha256,
        });
      }
      if (row.expiresAt.getTime() < Date.now()) {
        throw new ApiError('upload_incomplete', '上传批次不存在或已过期');
      }
      if (row.consumedByDocumentId) throw new ApiError('upload_consumed', '批次已被文档消费');
      let parts;
      try {
        parts = orderedCompleteParts(input.parts, row.multipart.partCount);
      } catch {
        throw new ApiError('validation_failed', '必须提交从 1 开始的完整连续分片清单');
      }
      let bytes: Buffer | null = null;
      try {
        await completeMultipartUpload(
          row.multipart.storageKey,
          input.upload_id,
          parts.map((part) => ({ partNumber: part.part_number, etag: part.etag })),
        );
      } catch (error) {
        // CompleteMultipartUpload 已在 S3 成功、但 API 在落库前中断时，重试会收到
        // NoSuchUpload。先回读最终对象；字节正确即可把这次重试收敛为幂等成功。
        bytes = await getObjectBytes(row.multipart.storageKey);
        const recovered = bytes !== null
          && bytes.length === row.file.byteSize
          && sha256Hex(bytes) === row.file.sha256;
        if (!recovered) {
          if (shouldRestartMultipart(error)) {
            throw new ApiError('upload_incomplete', 'multipart 已失效，请重新建立分片上传');
          }
          throw error;
        }
      }
      bytes ??= await getObjectBytes(row.multipart.storageKey);
      if (!bytes || bytes.length !== row.file.byteSize) {
        await deleteObjectIfPossible(row.multipart.storageKey);
        throw new ApiError('sha256_mismatch', 'multipart 合并后的文件大小不一致');
      }
      const sha256 = sha256Hex(bytes);
      if (sha256 !== row.file.sha256) {
        await deleteObjectIfPossible(row.multipart.storageKey);
        throw new ApiError('sha256_mismatch', 'multipart 合并后的整文件 sha256 不一致');
      }
      const completedAt = new Date();
      await tx.update(multipartUpload).set({
        state: 'completed', resultSha256: sha256,
        resultByteSize: bytes.length, completedAt,
      }).where(eq(multipartUpload.id, input.upload_id));
      await tx.update(uploadFile).set({ multipartVerifiedAt: completedAt })
        .where(eq(uploadFile.id, row.file.id));
      return MultipartCompleteResponse.parse({ completed: true, byte_size: bytes.length, sha256 });
    }),
  });
}
