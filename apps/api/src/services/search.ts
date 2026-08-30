import {
  and, desc, eq, gte, ilike, isNull, lt, lte, or, sql,
} from 'drizzle-orm';
import { SearchResponse, type SearchEntityTypeT, type SearchQueryT } from '@amr/contracts';
import { db } from '../db/client.js';
import {
  document, documentManualMetadata, encounter, searchEntry,
} from '../db/schema.js';
import { ApiError } from '../errors.js';

interface SearchCursor {
  sortAt: string | null;
  id: string;
}

function encodeCursor(value: SearchCursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(value: string): SearchCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid cursor');
    const cursor = parsed as Record<string, unknown>;
    if ((cursor.sortAt !== null && typeof cursor.sortAt !== 'string')
        || typeof cursor.id !== 'string') throw new Error('invalid cursor');
    if (cursor.sortAt !== null && Number.isNaN(Date.parse(cursor.sortAt as string))) {
      throw new Error('invalid cursor');
    }
    return { sortAt: cursor.sortAt as string | null, id: cursor.id };
  } catch {
    throw new ApiError('validation_failed', '游标无效');
  }
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function highlight(value: string, query: string): string | null {
  const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return null;
  const start = Math.max(0, index - 36);
  const end = Math.min(value.length, index + query.length + 72);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < value.length ? '…' : '';
  return `${prefix}${escapeHtml(value.slice(start, index))}<em>${escapeHtml(
    value.slice(index, index + query.length),
  )}</em>${escapeHtml(value.slice(index + query.length, end))}${suffix}`;
}

function matchedBy(entityType: SearchEntityTypeT): string[] {
  if (entityType === 'document') return ['manual_metadata'];
  if (entityType === 'encounter') return ['manual_encounter'];
  return [`confirmed_${entityType}`];
}

export async function searchCore(input: SearchQueryT) {
  if (input.mode !== 'keyword') {
    throw new ApiError('capability_unavailable', '语义检索插件当前不可用');
  }

  const pattern = `%${escapeLike(input.q)}%`;
  const conditions = [
    eq(searchEntry.personId, input.person_id),
    or(ilike(searchEntry.title, pattern), ilike(searchEntry.coreBody, pattern))!,
    // 当前 P0 投影必须排除已经归档的 document/encounter。后续实体由各自投影器负责清除。
    sql`(${searchEntry.entityType} <> 'document' or ${document.archivedAt} is null)`,
    sql`(${searchEntry.entityType} <> 'encounter' or ${encounter.archivedAt} is null)`,
  ];
  if (input.entity_type) conditions.push(eq(searchEntry.entityType, input.entity_type));
  if (input.from) conditions.push(gte(searchEntry.occurredOn, input.from));
  if (input.to) conditions.push(lte(searchEntry.occurredOn, input.to));
  if (input.doc_type) {
    conditions.push(and(
      eq(searchEntry.entityType, 'document'),
      sql`case when ${documentManualMetadata.fieldProvenance} ? 'doc_type'
        then ${documentManualMetadata.docType} else 'unknown' end = ${input.doc_type}`,
    )!);
  }
  if (input.facility_id) {
    conditions.push(or(
      and(
        eq(searchEntry.entityType, 'document'),
        sql`${documentManualMetadata.fieldProvenance} ? 'facility_id'`,
        eq(documentManualMetadata.facilityId, input.facility_id),
      ),
      and(eq(searchEntry.entityType, 'encounter'), eq(encounter.facilityId, input.facility_id)),
    )!);
  }
  if (input.department) {
    conditions.push(or(
      and(
        eq(searchEntry.entityType, 'document'),
        sql`${documentManualMetadata.fieldProvenance} ? 'department'`,
        eq(documentManualMetadata.department, input.department),
      ),
      and(eq(searchEntry.entityType, 'encounter'), eq(encounter.department, input.department)),
    )!);
  }
  if (input.encounter_id) {
    conditions.push(or(
      and(eq(searchEntry.entityType, 'document'), eq(document.encounterId, input.encounter_id)),
      and(eq(searchEntry.entityType, 'encounter'), eq(encounter.id, input.encounter_id)),
    )!);
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    conditions.push(cursor.sortAt === null
      ? and(isNull(searchEntry.sortAt), lt(searchEntry.id, cursor.id))!
      : or(
          lt(searchEntry.sortAt, new Date(cursor.sortAt)),
          isNull(searchEntry.sortAt),
          and(eq(searchEntry.sortAt, new Date(cursor.sortAt)), lt(searchEntry.id, cursor.id)),
        )!);
  }

  const rows = await db.select({
    id: searchEntry.id,
    entityType: searchEntry.entityType,
    entityId: searchEntry.entityId,
    documentId: searchEntry.documentId,
    personId: searchEntry.personId,
    occurredOn: searchEntry.occurredOn,
    sortAt: searchEntry.sortAt,
    title: searchEntry.title,
    coreBody: searchEntry.coreBody,
  }).from(searchEntry)
    .leftJoin(document, and(
      eq(searchEntry.entityType, 'document'), eq(document.id, searchEntry.entityId),
    ))
    .leftJoin(documentManualMetadata, eq(documentManualMetadata.documentId, document.id))
    .leftJoin(encounter, and(
      eq(searchEntry.entityType, 'encounter'), eq(encounter.id, searchEntry.entityId),
    ))
    .where(and(...conditions))
    .orderBy(sql`${searchEntry.sortAt} desc nulls last`, desc(searchEntry.id))
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return SearchResponse.parse({
    results: page.map((row) => ({
      entity_type: row.entityType,
      entity_id: row.entityId,
      document_id: row.documentId,
      person_id: row.personId,
      title: row.title,
      occurred_on: row.occurredOn,
      highlights: [highlight(row.title, input.q), ...row.coreBody.split('\n').map((line) => highlight(line, input.q))]
        .filter((item): item is string => item !== null)
        .slice(0, 3),
      matched_by: matchedBy(row.entityType as SearchEntityTypeT),
    })),
    next_cursor: rows.length > input.limit && last
      ? encodeCursor({ sortAt: last.sortAt?.toISOString() ?? null, id: last.id })
      : null,
    coverage: 'core_manual',
  });
}
