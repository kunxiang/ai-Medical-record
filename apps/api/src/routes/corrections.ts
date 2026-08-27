import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import {
  ArchiveRequest, ArchiveResponse, CaptureSidecar, CorrectionPageMove,
  CorrectionPersonReassign, CorrectionResponse, CorrectionSidecar, MergeRequest,
  MovePageRequest, PersonCheckAckRequest, PersonCheckAckResponse, ReassignRequest,
  S1Artifact, SplitRequest, Uuid,
  canonicalJsonString, dedupKey,
} from '@amr/contracts';
import {
  buildKey, canonicalJson, newDocShortId, parseKey, serverTimestamp,
} from '@amr/storage';
import { requireDocumentAccess, requirePersonAccess } from '../access.js';
import { db, type Tx } from '../db/client.js';
import { aiJob, document, documentPage, humanOperation, person } from '../db/schema.js';
import { planMerge, planMovePage, planSplit, type PageMovePlan } from '../document-boundaries.js';
import { defineRoute } from '../define-route.js';
import { ApiError, notFound } from '../errors.js';
import { appendAudit, appendJournal, appendManifest } from '../journal.js';
import { enqueue } from '../jobs/queue.js';
import { deletePrefix, getObjectText, listKeys, putWorm } from '../s3.js';

interface DocumentContext {
  id: string;
  shortId: string;
  personId: string;
  personSlug: string;
  displayName: string;
  personCheck: string;
  personCheckAckAt: Date | null;
  archivedAt: Date | null;
  s1ArtifactKey: string | null;
  pageCount: number;
  capturedAt: Date;
  captureDate: string;
  uploadedBy: string;
  originalFilename: string | null;
}

interface BoundaryPageRow {
  id: string;
  pageNo: number;
  storageKey: string;
  contentSha256: string;
  byteSize: number;
  mimeType: string;
  width: number;
  height: number;
  captureOrder: number;
}

async function lockedDocument(tx: Tx, documentId: string): Promise<DocumentContext> {
  const row = (await tx.select({
    id: document.id, shortId: document.shortId, personId: document.personId,
    personSlug: person.slug, displayName: person.displayName,
    personCheck: document.personCheck, personCheckAckAt: document.personCheckAckAt,
    archivedAt: document.archivedAt, s1ArtifactKey: document.s1ArtifactKey,
    pageCount: document.pageCount, capturedAt: document.capturedAt,
    captureDate: document.captureDate, uploadedBy: document.uploadedBy,
    originalFilename: document.originalFilename,
  }).from(document).innerJoin(person, eq(person.id, document.personId))
    .where(eq(document.id, documentId)).limit(1).for('update'))[0];
  if (!row) throw notFound();
  return row;
}

async function lockedDocumentPair(
  tx: Tx,
  firstId: string,
  secondId: string,
): Promise<[DocumentContext, DocumentContext]> {
  const ids = [firstId, secondId].sort();
  const first = await lockedDocument(tx, ids[0]!);
  const second = await lockedDocument(tx, ids[1]!);
  return first.id === firstId ? [first, second] : [second, first];
}

async function boundaryPages(tx: Tx, documentId: string): Promise<BoundaryPageRow[]> {
  return tx.select({
    id: documentPage.id, pageNo: documentPage.pageNo, storageKey: documentPage.storageKey,
    contentSha256: documentPage.contentSha256, byteSize: documentPage.byteSize,
    mimeType: documentPage.mimeType, width: documentPage.width, height: documentPage.height,
    captureOrder: documentPage.captureOrder,
  }).from(documentPage).where(eq(documentPage.documentId, documentId))
    .orderBy(asc(documentPage.pageNo));
}

async function priorOperation<T>(
  tx: Tx,
  input: { client_operation_id: string },
  kind: string,
  documentId: string,
  request: unknown,
): Promise<T | null> {
  const row = (await tx.select().from(humanOperation)
    .where(eq(humanOperation.id, input.client_operation_id)).limit(1).for('update'))[0];
  if (!row) return null;
  if (row.kind !== kind || row.documentId !== documentId
      || canonicalJsonString(row.request) !== canonicalJsonString(request)) {
    throw new ApiError('validation_failed', 'client_operation_id 已用于不同的人工操作');
  }
  return row.result as T;
}

async function persistPersonReassignCorrection(args: {
  storageKey: string;
  clientOperationId: string;
  fromPersonSlug: string;
  toPersonSlug: string;
  reason: string;
  correctedAt: string;
}): Promise<number> {
  const parsed = parseKey(args.storageKey);
  if (parsed.kind !== 'page') throw new ApiError('internal_error', '原件 key 结构无效');
  const prefix = `people/${parsed.personSlug}/${parsed.captureDate.slice(0, 4)}/${parsed.captureDate}__${parsed.docShortId}/`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const correctionKeys = (await listKeys(prefix)).filter((key) => /\/correction-\d{4}\.json$/.test(key));
    let maxSeq = 0;
    for (const key of correctionKeys) {
      const seq = Number(/correction-(\d{4})\.json$/.exec(key)?.[1] ?? 0);
      maxSeq = Math.max(maxSeq, seq);
      const existing = await getObjectText(key);
      if (existing) {
        const sidecar = CorrectionPersonReassign.safeParse(JSON.parse(existing.text));
        if (sidecar.success && sidecar.data.client_operation_id === args.clientOperationId) return sidecar.data.seq;
      }
    }
    const seq = maxSeq + 1;
    const sidecar = CorrectionPersonReassign.parse({
      schema_version: '1.1', kind: 'person_reassign', seq,
      corrected_at: args.correctedAt, client_operation_id: args.clientOperationId,
      from_person_slug: args.fromPersonSlug, to_person_slug: args.toPersonSlug,
      reason: args.reason,
    });
    const result = await putWorm(buildKey.correction({
      personSlug: parsed.personSlug, captureDate: parsed.captureDate,
      docShortId: parsed.docShortId, seq,
    }), canonicalJson(sidecar), 'application/json');
    if (result === 'created') return seq;
  }
  throw new ApiError('internal_error', '纠正序号连续冲突，请稍后重试');
}

async function persistPageMoveCorrection(args: {
  storageKey: string;
  clientOperationId: string;
  fromDocShortId: string;
  toDocShortId: string;
  pageSha256: string;
  fromPageNo: number;
  toPageNo: number;
  correctedAt: string;
}): Promise<number> {
  const parsedKey = parseKey(args.storageKey);
  if (parsedKey.kind !== 'page') throw new ApiError('internal_error', '原件 key 结构无效');
  const prefix = `people/${parsedKey.personSlug}/${parsedKey.captureDate.slice(0, 4)}/` +
    `${parsedKey.captureDate}__${parsedKey.docShortId}/`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const correctionKeys = (await listKeys(prefix))
      .filter((key) => /\/correction-\d{4}\.json$/.test(key));
    let maxSeq = 0;
    for (const key of correctionKeys) {
      const seq = Number(/correction-(\d{4})\.json$/.exec(key)?.[1] ?? 0);
      maxSeq = Math.max(maxSeq, seq);
      const existing = await getObjectText(key);
      if (!existing) continue;
      const sidecar = CorrectionSidecar.safeParse(JSON.parse(existing.text));
      if (!sidecar.success || sidecar.data.kind !== 'page_move') continue;
      const current = sidecar.data;
      if (current.client_operation_id === args.clientOperationId
          && current.from_doc_short_id === args.fromDocShortId
          && current.to_doc_short_id === args.toDocShortId
          && current.page_sha256 === args.pageSha256
          && current.from_page_no === args.fromPageNo
          && current.to_page_no === args.toPageNo) {
        return current.seq;
      }
    }
    const seq = maxSeq + 1;
    const sidecar = CorrectionPageMove.parse({
      schema_version: '1.1', kind: 'page_move', seq,
      corrected_at: args.correctedAt, client_operation_id: args.clientOperationId,
      from_doc_short_id: args.fromDocShortId, to_doc_short_id: args.toDocShortId,
      page_sha256: args.pageSha256,
      from_page_no: args.fromPageNo, to_page_no: args.toPageNo,
    });
    const result = await putWorm(buildKey.correction({
      personSlug: parsedKey.personSlug, captureDate: parsedKey.captureDate,
      docShortId: parsedKey.docShortId, seq,
    }), canonicalJson(sidecar), 'application/json');
    if (result === 'created') return seq;
  }
  throw new ApiError('internal_error', '纠正序号连续冲突，请稍后重试');
}

async function persistPageMoves(args: {
  pages: BoundaryPageRow[];
  moves: PageMovePlan[];
  clientOperationId: string;
  fromDocShortId: string;
  toDocShortId: string;
  correctedAt: string;
}): Promise<number[]> {
  const byId = new Map(args.pages.map((page) => [page.id, page]));
  const seqs: number[] = [];
  for (const move of args.moves) {
    const page = byId.get(move.pageId);
    if (!page) throw new ApiError('internal_error', '边界规划引用了不存在的页');
    seqs.push(await persistPageMoveCorrection({
      storageKey: page.storageKey, clientOperationId: args.clientOperationId,
      fromDocShortId: args.fromDocShortId, toDocShortId: args.toDocShortId,
      pageSha256: move.pageSha256, fromPageNo: move.fromPageNo,
      toPageNo: move.toPageNo, correctedAt: args.correctedAt,
    }));
  }
  return seqs;
}

async function normalizePageNumbers(tx: Tx, documentId: string): Promise<number> {
  const rows = await tx.select({ id: documentPage.id }).from(documentPage)
    .where(eq(documentPage.documentId, documentId)).orderBy(asc(documentPage.pageNo));
  if (rows.length === 0) return 0;
  const offset = 100_000;
  await tx.update(documentPage).set({ pageNo: sql`${documentPage.pageNo} + ${offset}` })
    .where(eq(documentPage.documentId, documentId));
  for (const [index, row] of rows.entries()) {
    await tx.update(documentPage).set({ pageNo: index + 1 }).where(eq(documentPage.id, row.id));
  }
  return rows.length;
}

async function applyMoves(
  tx: Tx,
  sourceId: string,
  targetId: string,
  moves: PageMovePlan[],
): Promise<{ sourceCount: number; targetCount: number }> {
  for (const move of moves) {
    await tx.update(documentPage).set({ documentId: targetId, pageNo: move.toPageNo })
      .where(and(eq(documentPage.id, move.pageId), eq(documentPage.documentId, sourceId)));
  }
  const sourceCount = await normalizePageNumbers(tx, sourceId);
  const targetCount = await normalizePageNumbers(tx, targetId);
  return { sourceCount, targetCount };
}

async function requeueStage1(tx: Tx, documentId: string, personId: string): Promise<void> {
  const reset = await tx.update(aiJob).set({
    state: sql`case when ${aiJob.state} = 'running' then 'running' else 'pending' end`,
    attempt: 0, nextAttemptAt: sql`now()`, personId,
    lastError: null, updatedAt: sql`now()`,
  }).where(and(eq(aiJob.documentId, documentId), eq(aiJob.kind, 'stage1')))
    .returning({ id: aiJob.id });
  if (reset.length === 0) {
    await enqueue(tx, {
      kind: 'stage1', dedupKey: dedupKey.stage1(documentId), documentId, personId,
    });
  }
}

async function invalidateDerived(...documents: DocumentContext[]): Promise<void> {
  for (const current of documents) {
    await deletePrefix(buildKey.derivedPrefix({
      personSlug: current.personSlug, docShortId: current.shortId,
    }));
  }
}

function activeSamePerson(source: DocumentContext, target: DocumentContext): void {
  if (source.archivedAt || target.archivedAt) {
    throw new ApiError('validation_failed', '归档文档不能参与边界调整');
  }
  if (source.personId !== target.personId) {
    throw new ApiError('validation_failed', '只能在同一家庭人员的文档之间移动页面');
  }
}

export function registerCorrectionRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'PATCH',
    url: '/api/v1/documents/:id',
    input: ArchiveRequest.extend({ id: Uuid }),
    output: ArchiveResponse,
    handler: async ({ input, accountId }) => {
      await requireDocumentAccess(accountId, input.id, 'editor');
      return db.transaction(async (tx) => {
        const current = await lockedDocument(tx, input.id);
        const request = {
          archived: input.archived, reason: input.reason,
          client_operation_id: input.client_operation_id,
        };
        const prior = await priorOperation<unknown>(tx, input, 'document_archive', input.id, request);
        if (prior) return ArchiveResponse.parse(prior);
        const at = serverTimestamp();
        const archivedAt = input.archived ? new Date(at) : null;
        const result = ArchiveResponse.parse({
          document_id: input.id, archived: input.archived,
          archived_at: archivedAt?.toISOString() ?? null,
        });
        await tx.update(document).set({ archivedAt }).where(eq(document.id, input.id));
        await appendJournal(tx, current.personSlug, {
          schema_version: '1.0', event: 'document_archive',
          event_id: input.client_operation_id, at, by_account_id: accountId,
          client_operation_id: input.client_operation_id,
          document_short_id: current.shortId, archived: input.archived, reason: input.reason,
        });
        await appendAudit(tx, {
          schema_version: '1.0', op: 'document_archive',
          event_id: input.client_operation_id, at, account_id: accountId,
          document_short_id: current.shortId, person_slug: current.personSlug,
          archived: input.archived, reason: input.reason,
        });
        await tx.insert(humanOperation).values({
          id: input.client_operation_id, kind: 'document_archive', documentId: input.id,
          request, result,
        });
        return result;
      });
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/documents/:id/person-check/ack',
    input: PersonCheckAckRequest.extend({ id: Uuid }),
    output: PersonCheckAckResponse,
    handler: async ({ input, accountId }) => {
      await requireDocumentAccess(accountId, input.id, 'editor');
      return db.transaction(async (tx) => {
        const current = await lockedDocument(tx, input.id);
        const request = { reason: input.reason, client_operation_id: input.client_operation_id };
        const prior = await priorOperation<unknown>(tx, input, 'person_check_ack', input.id, request);
        if (prior) return PersonCheckAckResponse.parse(prior);
        if (current.personCheck !== 'mismatch' && current.personCheck !== 'unknown') {
          throw new ApiError('validation_failed', '当前文档没有需要确认的归人告警');
        }
        if (current.personCheckAckAt !== null) {
          throw new ApiError('validation_failed', '该归人告警已经确认');
        }
        let observedName: string | null = null;
        if (current.s1ArtifactKey) {
          const artifact = await getObjectText(current.s1ArtifactKey);
          if (artifact) {
            const parsed = S1Artifact.safeParse(JSON.parse(artifact.text));
            if (parsed.success) observedName = parsed.data.output.patient_name;
          }
        }
        const at = serverTimestamp();
        const result = PersonCheckAckResponse.parse({
          document_id: input.id, person_check_ack_at: at,
        });
        await tx.update(document).set({ personCheckAckAt: new Date(at) })
          .where(eq(document.id, input.id));
        await appendJournal(tx, current.personSlug, {
          schema_version: '1.0', event: 'person_check_ack',
          event_id: input.client_operation_id, at, by_account_id: accountId,
          client_operation_id: input.client_operation_id,
          document_short_id: current.shortId,
          from_check: current.personCheck,
          observed_name: observedName,
          expected_name: current.displayName,
          reason: input.reason,
        });
        await tx.insert(humanOperation).values({
          id: input.client_operation_id, kind: 'person_check_ack', documentId: input.id,
          request, result,
        });
        return result;
      });
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/documents/:id/reassign',
    input: ReassignRequest.extend({ id: Uuid }),
    output: CorrectionResponse,
    handler: async ({ input, accountId }) => {
      await requireDocumentAccess(accountId, input.id, 'editor');
      await requirePersonAccess(accountId, input.to_person_id, 'editor');
      return db.transaction(async (tx) => {
        const current = await lockedDocument(tx, input.id);
        const request = {
          to_person_id: input.to_person_id, reason: input.reason,
          client_operation_id: input.client_operation_id,
        };
        const prior = await priorOperation<unknown>(tx, input, 'person_reassign', input.id, request);
        if (prior) return CorrectionResponse.parse(prior);
        if (current.personId === input.to_person_id) {
          throw new ApiError('validation_failed', '文档已经属于目标档案');
        }
        const target = (await tx.select({ slug: person.slug }).from(person)
          .where(eq(person.id, input.to_person_id)).limit(1))[0];
        if (!target) throw notFound();
        const firstPage = (await tx.select({ storageKey: documentPage.storageKey }).from(documentPage)
          .where(and(eq(documentPage.documentId, input.id), eq(documentPage.pageNo, 1))).limit(1))[0];
        if (!firstPage) throw new ApiError('internal_error', '文档缺少第一页');
        const at = serverTimestamp();
        const seq = await persistPersonReassignCorrection({
          storageKey: firstPage.storageKey, clientOperationId: input.client_operation_id,
          fromPersonSlug: current.personSlug, toPersonSlug: target.slug,
          reason: input.reason, correctedAt: at,
        });
        const result = CorrectionResponse.parse({
          document_id: input.id, new_document_id: null, correction_seq: seq,
        });
        await tx.update(document).set({
          personId: input.to_person_id, personCheckAckAt: new Date(at),
          encounterId: null, s1ArtifactKey: null, s1PromptVersion: null,
        }).where(eq(document.id, input.id));
        const reset = await tx.update(aiJob).set({
          state: sql`case when ${aiJob.state} = 'running' then 'running' else 'pending' end`,
          attempt: 0, nextAttemptAt: sql`now()`,
          personId: input.to_person_id,
          lastError: null, updatedAt: sql`now()`,
        }).where(and(eq(aiJob.documentId, input.id), eq(aiJob.kind, 'stage1')))
          .returning({ id: aiJob.id });
        if (reset.length === 0) {
          await enqueue(tx, {
            kind: 'stage1', dedupKey: dedupKey.stage1(input.id),
            documentId: input.id, personId: input.to_person_id,
          });
        }
        await appendManifest(tx, {
          schema_version: '1.0', op: 'person_correct', event_id: input.client_operation_id,
          doc_short_id: current.shortId, to_person_slug: target.slug, created_at: at,
        });
        await appendJournal(tx, current.personSlug, {
          schema_version: '1.0', event: 'person_reassign',
          event_id: input.client_operation_id, at, by_account_id: accountId,
          client_operation_id: input.client_operation_id,
          document_short_id: current.shortId,
          from_person_slug: current.personSlug, to_person_slug: target.slug,
          reason: input.reason, correction_seq: seq,
        });
        await tx.insert(humanOperation).values({
          id: input.client_operation_id, kind: 'person_reassign', documentId: input.id,
          request, result,
        });
        return result;
      });
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/documents/:id/split',
    input: SplitRequest.extend({ id: Uuid }),
    output: CorrectionResponse,
    handler: async ({ input, accountId }) => {
      await requireDocumentAccess(accountId, input.id, 'editor');
      return db.transaction(async (tx) => {
        const source = await lockedDocument(tx, input.id);
        const request = {
          at_page_no: input.at_page_no, client_operation_id: input.client_operation_id,
        };
        const prior = await priorOperation<unknown>(tx, input, 'document_split', input.id, request);
        if (prior) return CorrectionResponse.parse(prior);
        if (source.archivedAt) throw new ApiError('validation_failed', '归档文档不能拆分');

        const pages = await boundaryPages(tx, source.id);
        let moves: PageMovePlan[];
        try {
          moves = planSplit(pages, input.at_page_no);
        } catch (error) {
          throw new ApiError('validation_failed', (error as Error).message);
        }
        await invalidateDerived(source);
        const movedById = new Map(moves.map((move) => [move.pageId, move]));
        const at = serverTimestamp();
        const newDocumentId = uuidv7();
        let newShortId = '';
        let capturePrefix = '';
        for (let attempt = 0; attempt < 3; attempt += 1) {
          newShortId = newDocShortId();
          const shortIdTaken = await tx.select({ id: document.id }).from(document)
            .where(eq(document.shortId, newShortId)).limit(1);
          if (shortIdTaken.length > 0) continue;
          const captureKey = buildKey.capture({
            personSlug: source.personSlug, captureDate: source.captureDate,
            docShortId: newShortId,
          });
          capturePrefix = captureKey.slice(0, -'capture.json'.length);
          const capture = CaptureSidecar.parse({
            schema_version: '2.0', document_id: newDocumentId, short_id: newShortId,
            person: { slug: source.personSlug, name: source.displayName, confirmed_by: 'api' },
            captured_at: source.capturedAt.toISOString(), capture_date: source.captureDate,
            source: 'split', uploaded_by: source.uploadedBy,
            client_document_id: `split:${input.client_operation_id}`,
            original_filename: source.originalFilename,
            pages: pages.filter((page) => movedById.has(page.id)).map((page) => {
              const move = movedById.get(page.id)!;
              return {
                page_no: move.toPageNo, capture_order: page.captureOrder,
                // 跨前缀引用原件；新目录只承载该拆分文档自己的 capture.json。
                file: page.storageKey, sha256: page.contentSha256, bytes: page.byteSize,
                mime: page.mimeType, width: page.width, height: page.height,
              };
            }),
            created_at: at,
          });
          if (await putWorm(captureKey, canonicalJson(capture), 'application/json') === 'created') break;
          if (attempt === 2) throw new ApiError('internal_error', '无法分配新文档存储目录');
        }

        const seqs = await persistPageMoves({
          pages, moves, clientOperationId: input.client_operation_id,
          fromDocShortId: source.shortId, toDocShortId: newShortId, correctedAt: at,
        });
        await deletePrefix(buildKey.derivedPrefix({
          personSlug: source.personSlug, docShortId: newShortId,
        }));

        await tx.insert(document).values({
          id: newDocumentId, shortId: newShortId, personId: source.personId,
          pageCount: moves.length, source: 'split', originalFilename: source.originalFilename,
          capturedAt: source.capturedAt, captureDate: source.captureDate,
          uploadedBy: source.uploadedBy, status: 'ready',
          clientDocumentId: `split:${input.client_operation_id}`,
        });
        const counts = await applyMoves(tx, source.id, newDocumentId, moves);
        await tx.update(document).set({
          pageCount: counts.sourceCount, encounterId: null, status: 'ready',
          s1ArtifactKey: null, s1PromptVersion: null, personCheck: 'unknown',
        }).where(eq(document.id, source.id));
        await tx.update(document).set({ pageCount: counts.targetCount })
          .where(eq(document.id, newDocumentId));
        await requeueStage1(tx, source.id, source.personId);
        await requeueStage1(tx, newDocumentId, source.personId);
        await appendManifest(tx, {
          schema_version: '1.0', op: 'add', event_id: input.client_operation_id,
          doc_short_id: newShortId, person_slug: source.personSlug,
          prefix: capturePrefix, created_at: at, origin: 'split',
        });
        await appendJournal(tx, source.personSlug, {
          schema_version: '1.0', event: 'document_split',
          event_id: input.client_operation_id, at, by_account_id: accountId,
          client_operation_id: input.client_operation_id,
          from_doc_short_id: source.shortId, to_doc_short_id: newShortId,
          page_sha256: moves.map((move) => move.pageSha256),
        });
        const result = CorrectionResponse.parse({
          document_id: source.id, new_document_id: newDocumentId,
          correction_seq: Math.min(...seqs),
        });
        await tx.insert(humanOperation).values({
          id: input.client_operation_id, kind: 'document_split', documentId: source.id,
          request, result,
        });
        return result;
      });
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/documents/:id/merge',
    input: MergeRequest.extend({ id: Uuid }),
    output: CorrectionResponse,
    handler: async ({ input, accountId }) => {
      if (input.id === input.absorb_document_id) {
        throw new ApiError('validation_failed', '文档不能合并自身');
      }
      await requireDocumentAccess(accountId, input.id, 'editor');
      await requireDocumentAccess(accountId, input.absorb_document_id, 'editor');
      return db.transaction(async (tx) => {
        const [target, source] = await lockedDocumentPair(tx, input.id, input.absorb_document_id);
        const request = {
          absorb_document_id: input.absorb_document_id,
          client_operation_id: input.client_operation_id,
        };
        const prior = await priorOperation<unknown>(tx, input, 'document_merge', target.id, request);
        if (prior) return CorrectionResponse.parse(prior);
        activeSamePerson(source, target);
        const [sourcePages, targetPages] = await Promise.all([
          boundaryPages(tx, source.id), boundaryPages(tx, target.id),
        ]);
        let moves: PageMovePlan[];
        try {
          moves = planMerge(sourcePages, targetPages.length);
        } catch (error) {
          throw new ApiError('validation_failed', (error as Error).message);
        }
        await invalidateDerived(source, target);
        const at = serverTimestamp();
        const seqs = await persistPageMoves({
          pages: sourcePages, moves, clientOperationId: input.client_operation_id,
          fromDocShortId: source.shortId, toDocShortId: target.shortId, correctedAt: at,
        });
        const counts = await applyMoves(tx, source.id, target.id, moves);
        await tx.update(document).set({
          pageCount: counts.sourceCount, archivedAt: new Date(at), encounterId: null,
          s1ArtifactKey: null, s1PromptVersion: null,
        }).where(eq(document.id, source.id));
        await tx.update(document).set({
          pageCount: counts.targetCount, encounterId: null, status: 'ready',
          s1ArtifactKey: null, s1PromptVersion: null, personCheck: 'unknown',
        }).where(eq(document.id, target.id));
        // 被吸收文档已经是 0 页归档记录。作业属于 L2，可直接删除；若 worker 正在处理，
        // 它随后按 job id 写终态会命中 0 行，不会把空文档重新激活。
        await tx.delete(aiJob).where(eq(aiJob.documentId, source.id));
        await requeueStage1(tx, target.id, target.personId);
        await appendJournal(tx, target.personSlug, {
          schema_version: '1.0', event: 'document_merge',
          event_id: input.client_operation_id, at, by_account_id: accountId,
          client_operation_id: input.client_operation_id,
          from_doc_short_id: source.shortId, to_doc_short_id: target.shortId,
          page_sha256: moves.map((move) => move.pageSha256),
        });
        const result = CorrectionResponse.parse({
          document_id: target.id, new_document_id: null,
          correction_seq: Math.min(...seqs),
        });
        await tx.insert(humanOperation).values({
          id: input.client_operation_id, kind: 'document_merge', documentId: target.id,
          request, result,
        });
        return result;
      });
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/documents/:id/move-page',
    input: MovePageRequest.extend({ id: Uuid }),
    output: CorrectionResponse,
    handler: async ({ input, accountId }) => {
      if (input.id === input.to_document_id) {
        throw new ApiError('validation_failed', '页面目标不能是当前文档');
      }
      await requireDocumentAccess(accountId, input.id, 'editor');
      await requireDocumentAccess(accountId, input.to_document_id, 'editor');
      return db.transaction(async (tx) => {
        const [source, target] = await lockedDocumentPair(tx, input.id, input.to_document_id);
        const request = {
          page_no: input.page_no, to_document_id: input.to_document_id,
          client_operation_id: input.client_operation_id,
        };
        const prior = await priorOperation<unknown>(tx, input, 'document_move_page', source.id, request);
        if (prior) return CorrectionResponse.parse(prior);
        activeSamePerson(source, target);
        const [sourcePages, targetPages] = await Promise.all([
          boundaryPages(tx, source.id), boundaryPages(tx, target.id),
        ]);
        let move: PageMovePlan;
        try {
          move = planMovePage(sourcePages, input.page_no, targetPages.length);
        } catch (error) {
          throw new ApiError('validation_failed', (error as Error).message);
        }
        await invalidateDerived(source, target);
        const at = serverTimestamp();
        const seqs = await persistPageMoves({
          pages: sourcePages, moves: [move], clientOperationId: input.client_operation_id,
          fromDocShortId: source.shortId, toDocShortId: target.shortId, correctedAt: at,
        });
        const counts = await applyMoves(tx, source.id, target.id, [move]);
        for (const [current, count] of [[source, counts.sourceCount], [target, counts.targetCount]] as const) {
          await tx.update(document).set({
            pageCount: count, encounterId: null, status: 'ready',
            s1ArtifactKey: null, s1PromptVersion: null, personCheck: 'unknown',
          }).where(eq(document.id, current.id));
          await requeueStage1(tx, current.id, current.personId);
        }
        await appendJournal(tx, source.personSlug, {
          schema_version: '1.0', event: 'document_move_page',
          event_id: input.client_operation_id, at, by_account_id: accountId,
          client_operation_id: input.client_operation_id,
          from_doc_short_id: source.shortId, to_doc_short_id: target.shortId,
          page_sha256: [move.pageSha256],
        });
        const result = CorrectionResponse.parse({
          document_id: source.id, new_document_id: null,
          correction_seq: seqs[0],
        });
        await tx.insert(humanOperation).values({
          id: input.client_operation_id, kind: 'document_move_page', documentId: source.id,
          request, result,
        });
        return result;
      });
    },
  });
}
