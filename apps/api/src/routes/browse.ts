import { and, desc, eq, gte, lte, or, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CaptureDiscardRequest, CaptureDiscardResponse, DocumentListQuery, DocumentListResponse,
  Uuid, decodeCursor, encodeCursor,
} from '@amr/contracts';
import { serverTimestamp } from '@amr/storage';
import { requireDocumentAccess, requirePersonAccess } from '../access.js';
import { db } from '../db/client.js';
import { captureDiscardEvent, document, documentPage, person } from '../db/schema.js';
import { defineRoute } from '../define-route.js';
import { ApiError, notFound } from '../errors.js';
import { ensureDerivative, type Variant } from '../derivatives.js';
import { appendJournal } from '../journal.js';
import { lockPerson } from '../person-service.js';
import { presignGetKey } from '../s3.js';

export function registerBrowseRoutes(app: FastifyInstance): void {
  // ── GET /documents(m1-02 §1)────────────────────────────────────────
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/documents',
    input: DocumentListQuery,
    output: DocumentListResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'viewer');

      const conds = [eq(document.personId, input.person_id)];
      if (input.from) conds.push(gte(document.captureDate, input.from));
      if (input.to) conds.push(lte(document.captureDate, input.to));
      if (input.cursor) {
        let c: { capturedAt: string; documentId: string };
        try {
          c = decodeCursor(input.cursor);
        } catch {
          throw new ApiError('validation_failed', '游标无效');
        }
        // (captured_at, id) 严格小于游标 —— 与排序键一致
        conds.push(
          or(
            lt(document.capturedAt, new Date(c.capturedAt)),
            and(eq(document.capturedAt, new Date(c.capturedAt)), lt(document.id, c.documentId)),
          )!,
        );
      }

      const rows = await db
        .select()
        .from(document)
        .where(and(...conds))
        .orderBy(desc(document.capturedAt), desc(document.id))
        .limit(input.limit + 1);

      const page = rows.slice(0, input.limit);
      const firstPages = page.length
        ? await db
            .select({ documentId: documentPage.documentId, pageNo: documentPage.pageNo, mimeType: documentPage.mimeType })
            .from(documentPage)
            .where(and(
              eq(documentPage.pageNo, 1),
              sql`${documentPage.documentId} in ${sql.raw(`(${page.map((d) => `'${d.id}'`).join(',')})`)}`,
            ))
        : [];
      const fpByDoc = new Map(firstPages.map((f) => [f.documentId, f]));

      const last = page[page.length - 1];
      return {
        documents: page.map((d) => {
          const fp = fpByDoc.get(d.id);
          return {
            id: d.id, short_id: d.shortId, person_id: d.personId,
            capture_date: d.captureDate, captured_at: d.capturedAt.toISOString(),
            page_count: d.pageCount, doc_type: d.docType, status: d.status,
            original_filename: d.originalFilename,
            first_page: fp ? { page_no: fp.pageNo, mime_type: fp.mimeType } : null,
          };
        }),
        next_cursor: rows.length > input.limit && last ? encodeCursor(last.capturedAt.toISOString(), last.id) : null,
      };
    },
  });

  // ── 派生物:302 重定向(m1-01 §B2 / m1-02 §2)─────────────────────────
  // 只有这两个是**浏览**变体。ai 变体(ADR-050)是服务端内部喂给模型的输入,
  // 由 AI 管线自行生成并预签名 —— 不开放为浏览端点,别"顺手"把它加进这个数组。
  for (const variant of ['thumb', 'preview'] as const) {
    defineRoute(app, {
      method: 'GET',
      url: `/api/v1/documents/:id/pages/:n/${variant}`,
      input: z.object({
        id: Uuid, n: z.coerce.number().int().min(1),
        access_token: z.string().optional(),   // <img> 无法带 Authorization 头(m1/CHANGES #1)
      }),
      output: z.unknown(),
      auth: 'bearer-or-query',
      handler: async ({ input, accountId, reply }) => {
        await requireDocumentAccess(accountId, input.id, 'viewer');
        const rows = await db
          .select({
            storageKey: documentPage.storageKey, mimeType: documentPage.mimeType,
            personSlug: person.slug, shortId: document.shortId,
          })
          .from(documentPage)
          .innerJoin(document, eq(document.id, documentPage.documentId))
          .innerJoin(person, eq(person.id, document.personId))
          .where(and(eq(documentPage.documentId, input.id), eq(documentPage.pageNo, input.n)))
          .limit(1);
        const row = rows[0];
        if (!row) throw notFound();

        const { key, generated } = await ensureDerivative({
          personSlug: row.personSlug, docShortId: row.shortId, pageNo: input.n,
          variant: variant as Variant, sourceKey: row.storageKey, mimeType: row.mimeType,
        });
        const url = await presignGetKey(key, 300);
        // 302 让 <img loading="lazy"> 的原生懒加载真正生效(审核 #002 A-9)
        return reply
          .header('X-Amr-Generated', generated ? '1' : '0')
          .header('Cache-Control', 'private, max-age=240')
          .redirect(url, 302);
      },
    });
  }

  // ── POST /captures/discard(m1-02 §3)───────────────────────────────
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/captures/discard',
    input: CaptureDiscardRequest,
    output: CaptureDiscardResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'editor');
      const p = (await db.select().from(person).where(eq(person.id, input.person_id)).limit(1))[0];
      if (!p) throw notFound();
      await db.transaction(async (tx) => {
        await lockPerson(tx, input.person_id);
        // 幂等台账:同一 discard_event_id 重放只写一行 journal(m1-99 A8)。
        // 台账与 journal 同事务 ⇒ 要么都成,要么都不成。
        const claimed = await tx
          .insert(captureDiscardEvent)
          .values({
            id: input.discard_event_id,
            personId: input.person_id,
            clientDocumentId: input.client_document_id,
          })
          .onConflictDoNothing({ target: captureDiscardEvent.id })
          .returning({ id: captureDiscardEvent.id });
        if (claimed.length === 0) return;   // 已记录过,直接返回 recorded:true
        await appendJournal(tx, p.slug, {
          schema_version: '1.0',
          event: 'capture_discard',
          event_id: input.discard_event_id,   // 客户端持久化 ⇒ 重放幂等
          at: serverTimestamp(),
          by_account_id: accountId,
          client_document_id: input.client_document_id,
          person_slug: p.slug,
          captured_at: input.captured_at,
          page_count: input.page_count,
          reason: input.reason,
          detail: input.detail,
        });
      });
      return { recorded: true as const };
    },
  });
}
