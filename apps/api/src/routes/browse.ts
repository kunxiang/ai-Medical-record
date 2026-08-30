import { and, desc, eq, gte, ilike, inArray, lte, or, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CaptureDiscardRequest, CaptureDiscardResponse, DocumentListQuery, DocumentListResponse,
  Uuid, decodeDocumentCursor, encodeDocumentCursor,
} from '@amr/contracts';
import { serverTimestamp } from '@amr/storage';
import { requireDocumentAccess, requirePersonAccess } from '../access.js';
import { db } from '../db/client.js';
import {
  captureDiscardEvent, document, documentManualMetadata, documentPage, encounter,
  facility, person, processingSuggestion,
} from '../db/schema.js';
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

      const selectedDate = input.date_field === 'sampled' ? sql<string>`${documentManualMetadata.sampledOn}`
        : input.date_field === 'reported' ? sql<string>`${documentManualMetadata.reportedOn}`
        : input.date_field === 'encounter' ? sql<string>`${encounter.occurredOn}`
        : input.date_field === 'capture' ? sql<string>`${document.captureDate}`
        : sql<string>`coalesce(${documentManualMetadata.sampledOn}, ${documentManualMetadata.reportedOn}, ${encounter.occurredOn}, ${document.captureDate})`;
      const conds = [eq(document.personId, input.person_id)];
      if (input.from || input.to) conds.push(sql`${selectedDate} is not null`);
      if (input.from) conds.push(gte(selectedDate, input.from));
      if (input.to) conds.push(lte(selectedDate, input.to));

      if (input.encounter_id) conds.push(eq(document.encounterId, input.encounter_id));
      if (input.doc_type) {
        conds.push(sql`coalesce(${documentManualMetadata.docType}, 'unknown') = ${input.doc_type}`);
      }
      if (input.facility_id) {
        conds.push(and(
          sql`${documentManualMetadata.fieldProvenance} ? 'facility_id'`,
          eq(documentManualMetadata.facilityId, input.facility_id),
        )!);
      }
      if (input.department) conds.push(eq(documentManualMetadata.department, input.department));
      if (input.q) {
        const pattern = `%${input.q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        conds.push(or(
          ilike(document.originalFilename, pattern), ilike(documentManualMetadata.title, pattern),
          ilike(documentManualMetadata.note, pattern), ilike(documentManualMetadata.department, pattern),
          ilike(documentManualMetadata.facilityNameRaw, pattern),
        )!);
      }
      if (input.person_check) conds.push(eq(document.personCheck, input.person_check));
      if (input.acked === false) conds.push(sql`${document.personCheckAckAt} is null`);
      if (input.acked === true) conds.push(sql`${document.personCheckAckAt} is not null`);
      // 软删除默认过滤(m2-06 §1.3)
      if (!input.include_archived) conds.push(sql`${document.archivedAt} is null`);
      if (input.cursor) {
        let c: ReturnType<typeof decodeDocumentCursor>;
        try {
          c = decodeDocumentCursor(input.cursor);
        } catch {
          throw new ApiError('validation_failed', '游标无效');
        }
        if (c.dateField !== input.date_field) throw new ApiError('validation_failed', '游标与日期语义不一致');
        const capturedAt = new Date(c.capturedAt);
        conds.push(c.selectedDate === null
          ? and(sql`${selectedDate} is null`, or(
              lt(document.capturedAt, capturedAt),
              and(eq(document.capturedAt, capturedAt), lt(document.id, c.documentId)),
            )!)!
          : or(
              sql`${selectedDate} < ${c.selectedDate}`,
              sql`${selectedDate} is null`,
              and(eq(selectedDate, c.selectedDate), or(
                lt(document.capturedAt, capturedAt),
                and(eq(document.capturedAt, capturedAt), lt(document.id, c.documentId)),
              )!),
            )!);
      }

      const rows = await db
        .select({
          id: document.id, shortId: document.shortId, personId: document.personId,
          encounterId: document.encounterId, capturedAt: document.capturedAt,
          captureDate: document.captureDate, pageCount: document.pageCount,
          status: document.status, originalFilename: document.originalFilename,
          personCheck: document.personCheck, personCheckAckAt: document.personCheckAckAt,
          archivedAt: document.archivedAt,
          manualDocType: documentManualMetadata.docType,
          sampledOn: documentManualMetadata.sampledOn,
          reportedOn: documentManualMetadata.reportedOn,
          manualFacilityId: documentManualMetadata.facilityId,
          facilityNameRaw: documentManualMetadata.facilityNameRaw,
          department: documentManualMetadata.department,
          title: documentManualMetadata.title, note: documentManualMetadata.note,
          fieldProvenance: documentManualMetadata.fieldProvenance,
          revision: documentManualMetadata.revision,
          latestEncounterOn: encounter.occurredOn,
          selectedDate,
          assistSuggestionCount: sql<number>`(
            select count(*)::int from ${processingSuggestion}
            where ${processingSuggestion.subjectType} = 'document'
              and ${processingSuggestion.subjectId} = ${document.id}::text
              and ${processingSuggestion.state} in ('proposed', 'partially_accepted')
          )`,
        })
        .from(document)
        .leftJoin(documentManualMetadata, eq(documentManualMetadata.documentId, document.id))
        .leftJoin(encounter, eq(encounter.id, document.encounterId))
        .where(and(...conds))
        .orderBy(sql`${selectedDate} desc nulls last`, desc(document.capturedAt), desc(document.id))
        .limit(input.limit + 1);

      const page = rows.slice(0, input.limit);
      const firstPages = page.length
        ? await db
            .select({ documentId: documentPage.documentId, pageNo: documentPage.pageNo, mimeType: documentPage.mimeType })
            .from(documentPage)
            .where(and(eq(documentPage.pageNo, 1), inArray(documentPage.documentId, page.map((d) => d.id))))
        : [];
      const fpByDoc = new Map(firstPages.map((f) => [f.documentId, f]));

      // 机构名:归一后才有,未归一时为 null
      const facilityIds = [...new Set(page.map((d) => d.manualFacilityId)
        .filter((x): x is string => !!x))];
      const facilities = facilityIds.length
        ? await db.select({ id: facility.id, name: facility.name })
            .from(facility)
            .where(inArray(facility.id, facilityIds))
        : [];
      const facilityById = new Map(facilities.map((f) => [f.id, f.name]));

      const last = page[page.length - 1];
      return {
        documents: page.map((d) => {
          const fp = fpByDoc.get(d.id);
          const provenance = (d.fieldProvenance ?? {}) as Record<string, {
            source?: 'manual' | 'accepted_suggestion'; suggestion_id?: string | null;
          }>;
          const effective = <T>(field: string, manualValue: T | null, fallback: T | null) => {
            const entry = provenance[field];
            return entry
              ? { value: manualValue, source: entry.source ?? 'manual', suggestion_id: entry.suggestion_id ?? null }
              : { value: fallback, source: 'capture_fallback' as const, suggestion_id: null };
          };
          const facilityName = d.manualFacilityId
            ? facilityById.get(d.manualFacilityId) ?? d.facilityNameRaw
            : d.facilityNameRaw;
          const effectiveMetadata = {
            doc_type: effective('doc_type', d.manualDocType, 'unknown' as const),
            sampled_on: effective('sampled_on', d.sampledOn, null),
            reported_on: effective('reported_on', d.reportedOn, null),
            facility_name: effective(
              provenance.facility_id ? 'facility_id' : 'facility_name_raw', facilityName, facilityName,
            ),
            department: effective('department', d.department, null),
            title: effective('title', d.title, d.originalFilename),
            note: effective('note', d.note, null),
          };
          return {
            id: d.id, short_id: d.shortId, person_id: d.personId,
            capture_date: d.captureDate, captured_at: d.capturedAt.toISOString(),
            page_count: d.pageCount, doc_type: effectiveMetadata.doc_type.value ?? 'unknown', status: d.status,
            original_filename: d.originalFilename,
            first_page: fp ? { page_no: fp.pageNo, mime_type: fp.mimeType } : null,
            doc_type_confidence: null,
            sampled_on: effectiveMetadata.sampled_on.value,
            reported_on: effectiveMetadata.reported_on.value,
            facility_name: effectiveMetadata.facility_name.value,
            // ★ 两列都下发:告警条件恒为 person_check='mismatch' AND person_check_ack_at IS NULL
            person_check: d.personCheck as never,
            person_check_ack_at: d.personCheckAckAt?.toISOString() ?? null,
            archived_at: d.archivedAt?.toISOString() ?? null,
            encounter_id: d.encounterId,
            effective_metadata: effectiveMetadata,
            dates: {
              sampled_on: d.sampledOn, reported_on: d.reportedOn,
              latest_encounter_on: d.latestEncounterOn,
              captured_on: d.captureDate, selected_date: d.selectedDate,
              selected_date_field: input.date_field,
            },
            revision: d.revision ?? 0,
            assist_suggestion_count: d.assistSuggestionCount,
          };
        }),
        next_cursor: rows.length > input.limit && last ? encodeDocumentCursor({
          selectedDate: last.selectedDate, capturedAt: last.capturedAt.toISOString(),
          documentId: last.id, dateField: input.date_field,
        }) : null,
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
