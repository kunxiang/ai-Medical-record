import {
  and, desc, eq, gte, isNotNull, isNull, lt, lte, or, sql,
} from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  TimelineEvent, TimelineEventCreateRequest,
  type TimelineEventArchiveRequestT, type TimelineEventCreateRequestT,
  type TimelineEventListQueryT, type TimelineEventPatchRequestT, type TimelineEventT,
} from '@amr/contracts';
import { serverTimestamp } from '@amr/storage';
import { db, type Tx } from '../db/client.js';
import { encounter, person, searchEntry, timelineEvent } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { appendJournal } from '../journal.js';
import { recordOperation, replayOperation } from './operation-ledger.js';
import { projectStableSource, stableOriginPage, stableSourcePageOut } from './stable-source.js';

type TimelineEventRow = typeof timelineEvent.$inferSelect;
const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

export function timelineEventOut(row: TimelineEventRow): TimelineEventT {
  return TimelineEvent.parse({
    id: row.id, person_id: row.personId, encounter_id: row.encounterId,
    kind: row.kind, title: row.title, occurred_on: row.occurredOn,
    occurred_at: row.occurredAt?.toISOString() ?? null, time_precision: row.timePrecision,
    note: row.note, source_page: stableSourcePageOut(row), source: row.source,
    source_ref: row.sourceRef, revision: row.revision, created_by: row.createdBy,
    created_at: row.createdAt.toISOString(), updated_by: row.updatedBy,
    updated_at: row.updatedAt.toISOString(), archived_at: row.archivedAt?.toISOString() ?? null,
  });
}

async function assertEncounter(tx: Tx, personId: string, encounterId: string | null): Promise<void> {
  if (!encounterId) return;
  const row = (await tx.select({ id: encounter.id }).from(encounter).where(and(
    eq(encounter.id, encounterId), eq(encounter.personId, personId), isNull(encounter.archivedAt),
  )).limit(1))[0];
  if (!row) throw notFound();
}

async function projectTimelineSearch(
  tx: Tx, row: TimelineEventRow, sourceRevisionHash: string,
): Promise<void> {
  if (row.archivedAt) {
    await tx.delete(searchEntry).where(and(
      eq(searchEntry.entityType, 'timeline_event'), eq(searchEntry.entityId, row.id),
    ));
    return;
  }
  await tx.insert(searchEntry).values({
    id: row.id, personId: row.personId, entityType: 'timeline_event', entityId: row.id,
    documentId: row.currentDocumentId, occurredOn: row.occurredOn,
    sortAt: row.occurredAt ?? (row.occurredOn ? new Date(`${row.occurredOn}T00:00:00.000Z`) : null),
    title: row.title, coreBody: row.note ?? '', sourceRevisionHash,
  }).onConflictDoUpdate({
    target: [searchEntry.entityType, searchEntry.entityId],
    set: {
      documentId: row.currentDocumentId, occurredOn: row.occurredOn,
      sortAt: row.occurredAt ?? (row.occurredOn ? new Date(`${row.occurredOn}T00:00:00.000Z`) : null),
      title: row.title, coreBody: row.note ?? '', sourceRevisionHash, updatedAt: new Date(),
    },
  });
}

export async function createTimelineEvent(input: {
  personId: string; accountId: string; body: TimelineEventCreateRequestT;
}) {
  return db.transaction(async (tx) => {
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, input.personId)).limit(1).for('update'))[0];
    if (!owner) throw notFound();
    const request = { person_id: input.personId, ...input.body };
    const replay = await replayOperation<TimelineEventT>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return TimelineEvent.parse(replay.result);
    await assertEncounter(tx, input.personId, input.body.encounter_id);
    const projected = await projectStableSource(tx, {
      personId: input.personId, sourcePage: input.body.source_page,
      path: ['source_page'], entityLabel: 'timeline event',
    });
    const { warning: _warning, ...source } = projected;
    const at = serverTimestamp();
    const row = (await tx.insert(timelineEvent).values({
      id: uuidv7(), personId: input.personId, encounterId: input.body.encounter_id,
      kind: input.body.kind, title: input.body.title, occurredOn: input.body.occurred_on,
      occurredAt: input.body.occurred_at ? new Date(input.body.occurred_at) : null,
      timePrecision: input.body.time_precision, note: input.body.note, ...source,
      source: 'manual', sourceRef: null, revision: 1, createdBy: input.accountId,
      createdAt: new Date(at), updatedBy: input.accountId, updatedAt: new Date(at), archivedAt: null,
    }).returning())[0]!;
    await projectTimelineSearch(tx, row, replay.requestHash);
    const response = timelineEventOut(row);
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'timeline_event_upsert', subjectType: 'timeline_event', subjectId: row.id,
      personId: row.personId, requestHash: replay.requestHash, request, result: response,
    });
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'timeline_event_upsert', event_id: input.body.client_operation_id,
      at, by_account_id: input.accountId, client_operation_id: input.body.client_operation_id,
      person_slug: owner.slug, subject_id: row.id, revision: row.revision,
      before: null, after: response, correction_note: null,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response }, references: {},
    });
    return response;
  });
}

function patchInput(current: TimelineEventRow, body: TimelineEventPatchRequestT) {
  const pick = <T>(key: keyof TimelineEventPatchRequestT, fallback: T): T =>
    (has(body, key as string) ? body[key] : fallback) as T;
  return TimelineEventCreateRequest.parse({
    client_operation_id: body.client_operation_id,
    encounter_id: pick('encounter_id', current.encounterId), kind: pick('kind', current.kind),
    title: pick('title', current.title), occurred_on: pick('occurred_on', current.occurredOn),
    occurred_at: pick('occurred_at', current.occurredAt?.toISOString() ?? null),
    time_precision: pick('time_precision', current.timePrecision), note: pick('note', current.note),
    source_page: has(body, 'source_page') ? body.source_page ?? null : stableOriginPage(current),
  });
}

async function mutateTimelineEvent(input: {
  eventId: string; accountId: string;
  body: TimelineEventPatchRequestT | TimelineEventArchiveRequestT; archive: boolean;
}) {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(timelineEvent).where(eq(timelineEvent.id, input.eventId))
      .limit(1).for('update'))[0];
    if (!current) throw notFound();
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, current.personId)).limit(1))[0];
    if (!owner) throw notFound();
    const request = { timeline_event_id: input.eventId, archive: input.archive, ...input.body };
    const replay = await replayOperation<TimelineEventT>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return TimelineEvent.parse(replay.result);
    if (input.body.if_revision !== current.revision) {
      throw new ApiError('revision_conflict', '时间轴事实已被其他操作更新', {
        base_revision: input.body.if_revision, current: timelineEventOut(current), draft: input.body,
      });
    }
    if (current.archivedAt) throw notFound();
    const at = serverTimestamp();
    let row: TimelineEventRow;
    if (input.archive) {
      row = (await tx.update(timelineEvent).set({
        archivedAt: new Date(at), revision: current.revision + 1,
        updatedBy: input.accountId, updatedAt: new Date(at),
      }).where(eq(timelineEvent.id, current.id)).returning())[0]!;
    } else {
      const value = patchInput(current, input.body as TimelineEventPatchRequestT);
      await assertEncounter(tx, current.personId, value.encounter_id);
      const projected = await projectStableSource(tx, {
        personId: current.personId, sourcePage: value.source_page,
        path: ['source_page'], entityLabel: 'timeline event',
      });
      const { warning: _warning, ...source } = projected;
      row = (await tx.update(timelineEvent).set({
        encounterId: value.encounter_id, kind: value.kind, title: value.title,
        occurredOn: value.occurred_on, occurredAt: value.occurred_at ? new Date(value.occurred_at) : null,
        timePrecision: value.time_precision, note: value.note, ...source,
        revision: current.revision + 1, updatedBy: input.accountId, updatedAt: new Date(at),
      }).where(eq(timelineEvent.id, current.id)).returning())[0]!;
    }
    await projectTimelineSearch(tx, row, replay.requestHash);
    const response = timelineEventOut(row);
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'timeline_event_upsert', subjectType: 'timeline_event', subjectId: row.id,
      personId: row.personId, requestHash: replay.requestHash, request, result: response,
    });
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'timeline_event_upsert', event_id: input.body.client_operation_id,
      at, by_account_id: input.accountId, client_operation_id: input.body.client_operation_id,
      person_slug: owner.slug, subject_id: row.id, revision: row.revision,
      before: timelineEventOut(current), after: response, correction_note: input.body.correction_note,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response }, references: {},
    });
    return response;
  });
}

export const patchTimelineEvent = (input: {
  eventId: string; accountId: string; body: TimelineEventPatchRequestT;
}) => mutateTimelineEvent({ ...input, archive: false });

export const archiveTimelineEvent = (input: {
  eventId: string; accountId: string; body: TimelineEventArchiveRequestT;
}) => mutateTimelineEvent({ ...input, archive: true });

type TimelineCursor = { occurred_on: string | null; occurred_at: string | null; id: string };

function decodeCursor(value: string): TimelineCursor {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as TimelineCursor;
    if (typeof cursor.id !== 'string'
        || (cursor.occurred_on !== null && !/^\d{4}-\d{2}-\d{2}$/.test(cursor.occurred_on))
        || (cursor.occurred_at !== null && Number.isNaN(Date.parse(cursor.occurred_at)))) throw new Error();
    return cursor;
  } catch {
    throw new ApiError('validation_failed', '时间轴游标无效');
  }
}

export async function listTimelineEvents(input: TimelineEventListQueryT) {
  const conditions = [eq(timelineEvent.personId, input.person_id), isNull(timelineEvent.archivedAt)];
  if (input.kind) conditions.push(eq(timelineEvent.kind, input.kind));
  const range = [];
  if (input.from) range.push(gte(timelineEvent.occurredOn, input.from));
  if (input.to) range.push(lte(timelineEvent.occurredOn, input.to));
  if (range.length > 0) {
    conditions.push(input.include_undated
      ? or(and(...range)!, isNull(timelineEvent.occurredOn))!
      : and(...range)!);
  } else if (!input.include_undated) conditions.push(isNotNull(timelineEvent.occurredOn));
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    if (cursor.occurred_on === null) {
      conditions.push(and(isNull(timelineEvent.occurredOn), lt(timelineEvent.id, cursor.id))!);
    } else {
      const cursorAt = cursor.occurred_at ? new Date(cursor.occurred_at) : null;
      conditions.push(or(
        lt(timelineEvent.occurredOn, cursor.occurred_on),
        ...(input.include_undated ? [isNull(timelineEvent.occurredOn)] : []),
        and(eq(timelineEvent.occurredOn, cursor.occurred_on), cursorAt
          ? or(
              lt(timelineEvent.occurredAt, cursorAt), isNull(timelineEvent.occurredAt),
              and(eq(timelineEvent.occurredAt, cursorAt), lt(timelineEvent.id, cursor.id)),
            )
          : and(isNull(timelineEvent.occurredAt), lt(timelineEvent.id, cursor.id))),
      )!);
    }
  }
  const rows = await db.select().from(timelineEvent).where(and(...conditions))
    .orderBy(
      sql`${timelineEvent.occurredOn} desc nulls last`,
      sql`${timelineEvent.occurredAt} desc nulls last`,
      desc(timelineEvent.id),
    )
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    events: page.map(timelineEventOut),
    next_cursor: rows.length > input.limit && last ? Buffer.from(JSON.stringify({
      occurred_on: last.occurredOn, occurred_at: last.occurredAt?.toISOString() ?? null, id: last.id,
    })).toString('base64url') : null,
  };
}
