import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CaptureSidecar, DocumentCreate, DocumentOut, MAX_UPLOAD_BYTES, MIME_TO_EXT,
  PageSidecar, PageUrlResponse, PresignRequest, PresignResponse, Uuid,
  capturedAtInRange,
} from '@amr/contracts';

type Mime = keyof typeof MIME_TO_EXT;
import {
  buildKey, canonicalJson, captureDateInZone, newDocShortId, serverTimestamp,
} from '@amr/storage';
import { requireDocumentAccess, requirePersonAccess } from '../access.js';
import { db, type Tx } from '../db/client.js';
import {
  account, document, documentPage, person, uploadBatch, uploadFile,
} from '../db/schema.js';
import { defineRoute } from '../define-route.js';
import { ApiError, notFound } from '../errors.js';
import { appendManifest } from '../journal.js';
import { newId } from '../person-service.js';
import {
  copyWithLock, deleteObjectIfPossible, getObjectText, headObject, presignGet,
  presignPut, putWorm,
} from '../s3.js';
import { crashPoint } from '../test-hooks.js';

const hexToBase64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

export function registerDocumentRoutes(app: FastifyInstance): void {
  // ① presign(spec m0-06 §2.①)
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/uploads/presign',
    input: PresignRequest,
    output: PresignResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'editor');
      for (let attempt = 0; ; attempt++) {
        const docShortId = newDocShortId();
        const batchId = newId();
        try {
          const files = input.files.map((f) => ({
            id: newId(),
            batchId,
            filename: f.filename,
            mimeType: f.mime_type,
            byteSize: f.byte_size,
            sha256: f.sha256,
            incomingKey: buildKey.incoming({ batchId, uploadId: '' }),
          }));
          // incomingKey 需要各自的 uploadId
          for (const f of files) f.incomingKey = buildKey.incoming({ batchId, uploadId: f.id });

          await db.transaction(async (tx) => {
            await tx.insert(uploadBatch).values({
              id: batchId, docShortId, personId: input.person_id, createdBy: accountId,
              expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
            });
            await tx.insert(uploadFile).values(files);
          });

          const uploads = [];
          for (const f of files) {
            const { url, headers } = await presignPut(f.incomingKey, f.mimeType, hexToBase64(f.sha256));
            uploads.push({
              upload_id: f.id, url, method: 'PUT' as const, headers,
              expires_at: new Date(Date.now() + 900_000).toISOString(),
            });
          }
          return { batch_id: batchId, doc_short_id: docShortId, uploads };
        } catch (e) {
          const msg = e instanceof Error ? e.message : '';
          if (attempt < 5 && msg.includes('doc_short_id')) continue;
          throw e;
        }
      }
    },
  });

  // ③ 登记(spec m0-06 §2.③)
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/documents',
    input: DocumentCreate,
    output: DocumentOut,
    status: 201,
    handler: async ({ input, accountId, setStatus }) => {
      // 0
      await requirePersonAccess(accountId, input.person_id, 'editor');
      if (!capturedAtInRange(input.captured_at, new Date())) {
        throw new ApiError('validation_failed', 'captured_at 越界', {
          issues: [{ path: ['captured_at'], message: '必须在 2000-01-01 与 now+24h 之间' }],
        });
      }

      // 1. 幂等检查(canonical 比对,审核 #001 B4)
      const payloadBytes = canonicalJson(DocumentCreate.parse(input)).toString('utf-8');
      const existing = await db
        .select()
        .from(document)
        .where(and(eq(document.uploadedBy, accountId), eq(document.clientDocumentId, input.client_document_id)))
        .limit(1);
      if (existing[0]) {
        const prior = await loadDocumentOut(existing[0].id);
        const priorPayload = existing[0].columnSet as { m0_payload?: string } | null;
        if (priorPayload?.m0_payload === payloadBytes) {
          setStatus(200); // 幂等命中(spec m0-06 §3)
          return prior;
        }
        throw new ApiError('duplicate_client_document_id', '幂等键冲突且 payload 不同');
      }

      // 2. 批次检查
      const batchRows = await db.select().from(uploadBatch).where(eq(uploadBatch.id, input.batch_id)).limit(1);
      const batch = batchRows[0];
      if (!batch || batch.expiresAt.getTime() < Date.now()) {
        throw new ApiError('upload_incomplete', '上传批次不存在或已过期');
      }
      if (batch.personId !== input.person_id) {
        throw new ApiError('validation_failed', '批次归属与 person_id 不一致');
      }
      if (batch.consumedByDocumentId) throw new ApiError('upload_consumed', '批次已被其他文档消费');
      const filesInBatch = await db.select().from(uploadFile).where(eq(uploadFile.batchId, batch.id));
      const fileById = new Map(filesInBatch.map((f) => [f.id, f]));
      for (const p of input.pages) {
        if (!fileById.has(p.upload_id)) {
          throw new ApiError('validation_failed', `upload_id 不属于该批次: ${p.upload_id}`);
        }
      }

      // capture_date(spec m0-03 §3:上传者 account 时区)
      const acct = (await db.select().from(account).where(eq(account.id, accountId)).limit(1))[0]!;
      const captureDate = captureDateInZone(input.captured_at, acct.timezone);
      const personRow = (await db.select().from(person).where(eq(person.id, input.person_id)).limit(1))[0]!;
      const personSlug = personRow.slug;
      const docShortId = batch.docShortId;

      // 3+4. 逐页 Head 校验 → Head-then-Copy 搬运
      type PageStaged = {
        pageNo: number; finalKey: string; mime: Mime; byteSize: number;
        sha256: string; width: number; height: number; incomingKey: string; filename: string;
      };
      const staged: PageStaged[] = [];
      for (const p of input.pages) {
        const f = fileById.get(p.upload_id)!;
        const mime = f.mimeType as Mime;
        const finalKey = buildKey.page({
          personSlug, captureDate, docShortId, pageNo: p.page_no, ext: MIME_TO_EXT[mime],
        });
        const incoming = await headObject(f.incomingKey);
        if (!incoming) {
          // 崩溃重试路径:临时缺失 → 回查最终 key(spec m0-06 §2.③.3)
          const final = await headObject(finalKey);
          if (final && final.checksumSha256Base64 === hexToBase64(f.sha256)) {
            staged.push({
              pageNo: p.page_no, finalKey, mime, byteSize: final.byteSize,
              sha256: f.sha256, width: p.width, height: p.height,
              incomingKey: f.incomingKey, filename: f.filename,
            });
            continue;
          }
          throw new ApiError('upload_incomplete', `页 ${p.page_no} 未完成直传`);
        }
        if (incoming.byteSize !== f.byteSize || incoming.byteSize > MAX_UPLOAD_BYTES) {
          throw new ApiError('file_too_large', `页 ${p.page_no} 实测大小与登记不符或超限`);
        }
        if (incoming.contentType !== f.mimeType) {
          throw new ApiError('unsupported_media_type', `页 ${p.page_no} 实测 Content-Type 与登记不符`);
        }
        if (incoming.checksumSha256Base64 !== hexToBase64(f.sha256)) {
          throw new ApiError('sha256_mismatch', `页 ${p.page_no} 校验和不符`);
        }
        if (f.sha256 !== p.sha256) {
          throw new ApiError('sha256_mismatch', `页 ${p.page_no} 登记 sha256 与批次不符`);
        }

        const final = await headObject(finalKey);
        if (final) {
          if (final.checksumSha256Base64 === hexToBase64(f.sha256)) {
            // 幂等续跑
          } else {
            app.log.error({ finalKey }, '最终 key 已存在且内容不同 —— 报警');
            throw new ApiError('internal_error', '存储不一致,已记录待人工处理');
          }
        } else {
          await copyWithLock(f.incomingKey, finalKey, f.mimeType);
        }
        staged.push({
          pageNo: p.page_no, finalKey, mime, byteSize: f.byteSize, sha256: f.sha256,
          width: p.width, height: p.height, incomingKey: f.incomingKey, filename: f.filename,
        });
      }
      crashPoint('after-copy'); // A8 崩溃注入点(仅测试)

      // 5. WORM sidecars。
      // 续跑语义:最终 key 已有 capture.json 时它就是权威(WORM 写过即定),
      // 采纳其中的 document_id/created_at —— 否则重试方重新生成的 id 会使字节比对必然失败。
      const firstFile = fileById.get(input.pages.find((p) => p.page_no === 1)!.upload_id)!;
      const captureKeyEarly = buildKey.capture({ personSlug, captureDate, docShortId });
      const priorCapture = await getObjectText(captureKeyEarly);
      let documentId = newId();
      let createdAt = serverTimestamp();
      if (priorCapture) {
        const parsed = CaptureSidecar.safeParse(JSON.parse(priorCapture.text));
        if (parsed.success && parsed.data.client_document_id === input.client_document_id) {
          documentId = parsed.data.document_id;
          createdAt = parsed.data.created_at;
        } else {
          app.log.error({ key: captureKeyEarly }, '既有 capture.json 与本请求不属同一逻辑文档 —— 报警');
          throw new ApiError('internal_error', '存储不一致,已记录待人工处理');
        }
      }
      for (const s of staged) {
        const pageJson = PageSidecar.parse({
          schema_version: '2.0', document_short_id: docShortId, page_no: s.pageNo,
          file: `page-${String(s.pageNo).padStart(2, '0')}.${MIME_TO_EXT[s.mime]}`,
          sha256: s.sha256, bytes: s.byteSize, mime: s.mime,
          width: s.width, height: s.height, exif: null,
        });
        await putWormIdempotent(
          buildKey.pageMeta({ personSlug, captureDate, docShortId, pageNo: s.pageNo }),
          canonicalJson(pageJson), app,
        );
      }
      const capture = CaptureSidecar.parse({
        schema_version: '2.0', document_id: documentId, short_id: docShortId,
        person: { slug: personSlug, name: personRow.displayName, confirmed_by: 'api' },
        captured_at: input.captured_at, capture_date: captureDate,
        source: input.source, uploaded_by: accountId,
        client_document_id: input.client_document_id,
        original_filename: firstFile.filename,
        pages: staged.map((s) => ({
          page_no: s.pageNo, file: `page-${String(s.pageNo).padStart(2, '0')}.${MIME_TO_EXT[s.mime]}`,
          sha256: s.sha256, bytes: s.byteSize, mime: s.mime, width: s.width, height: s.height,
        })),
        created_at: createdAt,
      });
      await putWormIdempotent(captureKeyEarly, canonicalJson(capture), app);
      crashPoint('after-sidecar');

      // 6. DB 事务(manifests 追加为 COMMIT 前最后动作)
      await db.transaction(async (tx) => {
        await tx.insert(document).values({
          id: documentId, shortId: docShortId, personId: input.person_id,
          docType: 'unknown', pageCount: staged.length, source: input.source,
          originalFilename: firstFile.filename,
          capturedAt: new Date(input.captured_at), captureDate,
          uploadedBy: accountId, status: 'ready',
          clientDocumentId: input.client_document_id,
          // M0 内部:幂等 payload 快照暂存于 columnSet(该列 M0 无业务用途,提取层 M4 接管前腾退)
          columnSet: { m0_payload: payloadBytes },
        });
        await tx.insert(documentPage).values(
          staged.map((s) => ({
            id: newId(), documentId, pageNo: s.pageNo, storageKey: s.finalKey,
            contentSha256: s.sha256, byteSize: s.byteSize, mimeType: s.mime,
            width: s.width, height: s.height, captureOrder: s.pageNo,
          })),
        );
        await tx
          .update(uploadBatch)
          .set({ consumedByDocumentId: documentId })
          .where(eq(uploadBatch.id, batch.id));
        await appendManifest(tx, {
          schema_version: '1.0', op: 'add', doc_short_id: docShortId, person_slug: personSlug,
          prefix: `people/${personSlug}/${captureDate.slice(0, 4)}/${captureDate}__${docShortId}/`,
          created_at: createdAt,
        });
      });
      crashPoint('after-commit');

      // 7. 删除临时对象(在 COMMIT 后,审核 #001 #5)
      for (const s of staged) await deleteObjectIfPossible(s.incomingKey);

      // 8
      return loadDocumentOut(documentId);
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/documents/:id',
    input: z.object({ id: Uuid }),
    output: DocumentOut,
    handler: async ({ input, accountId }) => {
      await requireDocumentAccess(accountId, input.id, 'viewer');
      return loadDocumentOut(input.id);
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/documents/:id/pages/:n/url',
    input: z.object({ id: Uuid, n: z.coerce.number().int().min(1) }),
    output: PageUrlResponse,
    handler: async ({ input, accountId }) => {
      await requireDocumentAccess(accountId, input.id, 'viewer');
      const rows = await db
        .select()
        .from(documentPage)
        .where(and(eq(documentPage.documentId, input.id), eq(documentPage.pageNo, input.n)))
        .limit(1);
      if (!rows[0]) throw notFound();
      return {
        url: await presignGet(rows[0].storageKey),
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      };
    },
  });
}

/** WORM put 的幂等续跑判定(spec m0-06 §2.③.5):412 且既有内容相同 → 续跑;不同 → 报警。 */
async function putWormIdempotent(key: string, body: Buffer, app: FastifyInstance): Promise<void> {
  const result = await putWorm(key, body, 'application/json');
  if (result === 'exists') {
    const existing = await getObjectText(key);
    if (existing && Buffer.from(existing.text, 'utf-8').equals(body)) return;
    app.log.error({ key }, 'WORM 对象已存在且内容不同 —— 报警');
    throw new ApiError('internal_error', '存储不一致,已记录待人工处理');
  }
}

async function loadDocumentOut(documentId: string) {
  const d = (await db.select().from(document).where(eq(document.id, documentId)).limit(1))[0];
  if (!d) throw notFound();
  const pages = await db
    .select()
    .from(documentPage)
    .where(eq(documentPage.documentId, documentId));
  return {
    id: d.id, short_id: d.shortId, person_id: d.personId, status: d.status,
    doc_type: d.docType, source: d.source, captured_at: d.capturedAt.toISOString(),
    capture_date: d.captureDate, original_filename: d.originalFilename,
    pages: pages
      .sort((a, b) => a.pageNo - b.pageNo)
      .map((p) => ({
        page_no: p.pageNo, storage_key: p.storageKey, sha256: p.contentSha256,
        byte_size: p.byteSize, mime_type: p.mimeType, width: p.width, height: p.height,
      })),
    created_at: d.createdAt.toISOString(),
  };
}
