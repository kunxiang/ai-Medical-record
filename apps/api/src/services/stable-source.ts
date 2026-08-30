import { and, eq } from 'drizzle-orm';
import type { ObservationOriginPageT, ObservationSourcePageT } from '@amr/contracts';
import type { Tx } from '../db/client.js';
import { document, documentPage } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';

export type StableSourceRow = {
  originCaptureDocumentId: string | null;
  originCaptureOrder: number | null;
  objectSha256: string | null;
  logicalPageIndex: number | null;
  sourceBbox: unknown | null;
  currentDocumentId: string | null;
  currentPageNo: number | null;
};

export type StableSourceProjection = StableSourceRow & { warning: boolean };

export function stableSourcePageOut(row: StableSourceRow): ObservationSourcePageT | null {
  if (!row.originCaptureDocumentId || row.originCaptureOrder === null
      || !row.objectSha256 || row.logicalPageIndex === null) return null;
  return {
    origin_capture_document_id: row.originCaptureDocumentId,
    origin_capture_order: row.originCaptureOrder,
    object_sha256: row.objectSha256,
    logical_page_index: row.logicalPageIndex,
    bbox: row.sourceBbox as ObservationSourcePageT['bbox'],
    current_document_id: row.currentDocumentId,
    current_page_no: row.currentPageNo,
    source_available: row.currentDocumentId !== null && row.currentPageNo !== null,
  };
}

export function stableOriginPage(row: StableSourceRow): ObservationOriginPageT | null {
  const source = stableSourcePageOut(row);
  return source ? {
    origin_capture_document_id: source.origin_capture_document_id,
    origin_capture_order: source.origin_capture_order,
    object_sha256: source.object_sha256,
    logical_page_index: source.logical_page_index,
    bbox: source.bbox,
  } : null;
}

export async function projectStableSource(tx: Tx, input: {
  personId: string;
  sourcePage: ObservationOriginPageT | null;
  path: Array<string | number>;
  entityLabel: string;
}): Promise<StableSourceProjection> {
  if (!input.sourcePage) return {
    originCaptureDocumentId: null, originCaptureOrder: null, objectSha256: null,
    logicalPageIndex: null, sourceBbox: null, currentDocumentId: null, currentPageNo: null,
    warning: false,
  };
  const owner = (await tx.select({ id: document.id }).from(document).where(and(
    eq(document.id, input.sourcePage.origin_capture_document_id),
    eq(document.personId, input.personId),
  )).limit(1))[0];
  if (!owner) throw notFound();
  const page = (await tx.select({
    documentId: documentPage.documentId, pageNo: documentPage.pageNo,
    mimeType: documentPage.mimeType,
  }).from(documentPage).innerJoin(document, eq(document.id, documentPage.documentId)).where(and(
    eq(document.personId, input.personId),
    eq(documentPage.originCaptureDocumentId, input.sourcePage.origin_capture_document_id),
    eq(documentPage.originCaptureOrder, input.sourcePage.origin_capture_order),
    eq(documentPage.originObjectSha256, input.sourcePage.object_sha256),
  )).limit(1))[0];
  if (page && page.mimeType !== 'application/pdf' && input.sourcePage.logical_page_index !== 1) {
    throw new ApiError('validation_failed', `${input.entityLabel} 校验失败`, {
      issues: [{
        code: 'custom', path: [...input.path, 'logical_page_index'],
        message: '图片对象的 logical_page_index 必须为 1',
      }],
    });
  }
  return {
    originCaptureDocumentId: input.sourcePage.origin_capture_document_id,
    originCaptureOrder: input.sourcePage.origin_capture_order,
    objectSha256: input.sourcePage.object_sha256,
    logicalPageIndex: input.sourcePage.logical_page_index,
    sourceBbox: input.sourcePage.bbox,
    currentDocumentId: page?.documentId ?? null,
    currentPageNo: page?.pageNo ?? null,
    warning: !page,
  };
}
