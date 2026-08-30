import { and, desc, eq, gte, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  Encounter, EncounterDocumentsSetResponse, type EncounterT,
} from '@amr/contracts';
import { serverTimestamp } from '@amr/storage';
import { db, type Tx } from '../db/client.js';
import { document, encounter, facility, person, searchEntry } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { appendJournal } from '../journal.js';
import { recordOperation, replayOperation } from './operation-ledger.js';

type EncounterRow = typeof encounter.$inferSelect;

export function encounterOut(row: EncounterRow): EncounterT {
  return Encounter.parse({
    id: row.id, person_id: row.personId, encounter_type: row.encounterType,
    facility_id: row.facilityId, department: row.department,
    occurred_on: row.occurredOn, ended_on: row.endedOn,
    occurred_at: row.occurredAt?.toISOString() ?? null,
    chief_complaint: row.chiefComplaint, diagnosis_text: row.diagnosisText,
    doctor_advice: row.doctorAdvice, revision: row.revision,
    updated_by: row.updatedBy, updated_at: row.updatedAt.toISOString(),
    archived_at: row.archivedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  });
}

async function facilitySnapshot(tx: Tx, facilityId: string | null) {
  if (!facilityId) return null;
  const row = (await tx.select().from(facility).where(eq(facility.id, facilityId)).limit(1))[0];
  if (!row) throw notFound();
  return row;
}

function validateDates(occurredOn: string, endedOn: string | null): void {
  if (endedOn && endedOn < occurredOn) {
    throw new ApiError('validation_failed', 'ended_on 不能早于 occurred_on');
  }
}

async function projectEncounter(tx: Tx, row: EncounterRow, requestHash: string): Promise<void> {
  if (row.archivedAt) {
    await tx.delete(searchEntry).where(and(
      eq(searchEntry.entityType, 'encounter'), eq(searchEntry.entityId, row.id),
    ));
    return;
  }
  const title = row.department || row.chiefComplaint || `${row.occurredOn} 就诊`;
  const body = [row.encounterType, row.department, row.chiefComplaint, row.diagnosisText, row.doctorAdvice]
    .filter(Boolean).join('\n');
  await tx.insert(searchEntry).values({
    id: row.id, personId: row.personId, entityType: 'encounter', entityId: row.id,
    occurredOn: row.occurredOn, sortAt: row.occurredAt ?? new Date(`${row.occurredOn}T00:00:00.000Z`),
    title, coreBody: body, sourceRevisionHash: requestHash,
  }).onConflictDoUpdate({
    target: [searchEntry.entityType, searchEntry.entityId],
    set: {
      occurredOn: row.occurredOn,
      sortAt: row.occurredAt ?? new Date(`${row.occurredOn}T00:00:00.000Z`),
      title, coreBody: body, sourceRevisionHash: requestHash, updatedAt: new Date(),
    },
  });
}

export async function createEncounter(input: {
  personId: string; accountId: string; body: Record<string, any>;
}): Promise<EncounterT> {
  return db.transaction(async (tx) => {
    const p = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, input.personId)).limit(1).for('update'))[0];
    if (!p) throw notFound();
    const request = { person_id: input.personId, ...input.body };
    const replay = await replayOperation<EncounterT>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return Encounter.parse(replay.result);
    validateDates(input.body.occurred_on, input.body.ended_on);
    const reference = await facilitySnapshot(tx, input.body.facility_id);
    const at = serverTimestamp();
    const row = (await tx.insert(encounter).values({
      id: uuidv7(), personId: input.personId, encounterType: input.body.encounter_type,
      facilityId: input.body.facility_id, department: input.body.department,
      occurredOn: input.body.occurred_on, endedOn: input.body.ended_on,
      occurredAt: input.body.occurred_at ? new Date(input.body.occurred_at) : null,
      chiefComplaint: input.body.chief_complaint, diagnosisText: input.body.diagnosis_text,
      doctorAdvice: input.body.doctor_advice, revision: 1, updatedBy: input.accountId,
      createdAt: new Date(at), updatedAt: new Date(at),
    }).returning())[0]!;
    const response = encounterOut(row);
    await projectEncounter(tx, row, replay.requestHash);
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'encounter_upsert', subjectType: 'encounter', subjectId: row.id,
      personId: row.personId, requestHash: replay.requestHash, request, result: response,
    });
    await appendJournal(tx, p.slug, {
      schema_version: '1.0', event: 'encounter_upsert',
      event_id: input.body.client_operation_id, at, by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: p.slug,
      subject_id: row.id, revision: row.revision, before: null, after: response,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response },
      references: { facility: reference },
    });
    return response;
  });
}

export async function patchEncounter(input: {
  encounterId: string; accountId: string; body: Record<string, any>;
}): Promise<EncounterT> {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(encounter)
      .where(eq(encounter.id, input.encounterId)).limit(1).for('update'))[0];
    if (!current) throw notFound();
    const p = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, current.personId)).limit(1))[0];
    if (!p) throw notFound();
    const request = { encounter_id: input.encounterId, ...input.body };
    const replay = await replayOperation<EncounterT>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return Encounter.parse(replay.result);
    if (input.body.if_revision !== current.revision) {
      throw new ApiError('revision_conflict', '就诊记录已被其他操作更新', {
        base_revision: input.body.if_revision, current: encounterOut(current), draft: input.body,
      });
    }
    const at = serverTimestamp();
    const next = {
      encounterType: input.body.encounter_type ?? current.encounterType,
      occurredOn: input.body.occurred_on ?? current.occurredOn,
      endedOn: Object.prototype.hasOwnProperty.call(input.body, 'ended_on') ? input.body.ended_on : current.endedOn,
      occurredAt: Object.prototype.hasOwnProperty.call(input.body, 'occurred_at')
        ? (input.body.occurred_at ? new Date(input.body.occurred_at) : null) : current.occurredAt,
      facilityId: Object.prototype.hasOwnProperty.call(input.body, 'facility_id') ? input.body.facility_id : current.facilityId,
      department: Object.prototype.hasOwnProperty.call(input.body, 'department') ? input.body.department : current.department,
      chiefComplaint: input.body.chief_complaint ?? current.chiefComplaint,
      diagnosisText: input.body.diagnosis_text ?? current.diagnosisText,
      doctorAdvice: input.body.doctor_advice ?? current.doctorAdvice,
      archivedAt: Object.prototype.hasOwnProperty.call(input.body, 'archived')
        ? (input.body.archived ? new Date(at) : null) : current.archivedAt,
    };
    validateDates(next.occurredOn, next.endedOn);
    const reference = await facilitySnapshot(tx, next.facilityId);
    const row = (await tx.update(encounter).set({
      ...next, revision: current.revision + 1, updatedBy: input.accountId, updatedAt: new Date(at),
    }).where(eq(encounter.id, current.id)).returning())[0]!;
    const before = encounterOut(current);
    const response = encounterOut(row);
    await projectEncounter(tx, row, replay.requestHash);
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'encounter_upsert', subjectType: 'encounter', subjectId: row.id,
      personId: row.personId, requestHash: replay.requestHash, request, result: response,
    });
    await appendJournal(tx, p.slug, {
      schema_version: '1.0', event: 'encounter_upsert',
      event_id: input.body.client_operation_id, at, by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: p.slug,
      subject_id: row.id, revision: row.revision, before, after: response,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response },
      references: { facility: reference },
    });
    return response;
  });
}

export async function setEncounterDocuments(input: {
  encounterId: string; accountId: string; body: { client_operation_id: string; if_revision: number; document_ids: string[] };
}) {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(encounter)
      .where(eq(encounter.id, input.encounterId)).limit(1).for('update'))[0];
    if (!current) throw notFound();
    const p = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, current.personId)).limit(1))[0];
    if (!p) throw notFound();
    const request = { encounter_id: input.encounterId, ...input.body };
    const replay = await replayOperation<ReturnType<typeof EncounterDocumentsSetResponse.parse>>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return EncounterDocumentsSetResponse.parse(replay.result);
    if (input.body.if_revision !== current.revision) {
      throw new ApiError('revision_conflict', '就诊记录已被其他操作更新', {
        base_revision: input.body.if_revision, current: encounterOut(current), draft: input.body,
      });
    }
    const beforeIds = (await tx.select({ id: document.id }).from(document)
      .where(eq(document.encounterId, current.id))).map((row) => row.id).sort();
    const targets = input.body.document_ids.length === 0 ? [] : await tx.select({ id: document.id })
      .from(document).where(and(
        inArray(document.id, input.body.document_ids), eq(document.personId, current.personId),
        isNull(document.archivedAt),
      ));
    if (targets.length !== input.body.document_ids.length) throw notFound();
    await tx.update(document).set({ encounterId: null }).where(eq(document.encounterId, current.id));
    if (targets.length > 0) {
      await tx.update(document).set({ encounterId: current.id })
        .where(inArray(document.id, targets.map((row) => row.id)));
    }
    const at = serverTimestamp();
    const row = (await tx.update(encounter).set({
      revision: current.revision + 1, updatedBy: input.accountId, updatedAt: new Date(at),
    }).where(eq(encounter.id, current.id)).returning())[0]!;
    const reference = await facilitySnapshot(tx, row.facilityId);
    const response = EncounterDocumentsSetResponse.parse({
      encounter: encounterOut(row), document_ids: [...input.body.document_ids].sort(),
    });
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'encounter_documents_set', subjectType: 'encounter', subjectId: row.id,
      personId: row.personId, requestHash: replay.requestHash, request, result: response,
    });
    await appendJournal(tx, p.slug, {
      schema_version: '1.0', event: 'encounter_documents_set',
      event_id: input.body.client_operation_id, at, by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: p.slug,
      subject_id: row.id, revision: row.revision,
      before_document_ids: beforeIds, after_document_ids: response.document_ids,
      after: response.encounter,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response },
      references: { facility: reference },
    });
    return response;
  });
}

export async function listEncounters(input: {
  personId: string; from?: string; to?: string; cursor?: string; limit: number;
}) {
  const conditions = [eq(encounter.personId, input.personId), isNull(encounter.archivedAt)];
  if (input.from) conditions.push(gte(encounter.occurredOn, input.from));
  if (input.to) conditions.push(lte(encounter.occurredOn, input.to));
  if (input.cursor) {
    const [occurredOn, id] = Buffer.from(input.cursor, 'base64url').toString('utf8').split('|');
    if (!occurredOn || !id) throw new ApiError('validation_failed', '游标无效');
    conditions.push(or(
      lt(encounter.occurredOn, occurredOn),
      and(eq(encounter.occurredOn, occurredOn), lt(encounter.id, id)),
    )!);
  }
  const rows = await db.select().from(encounter).where(and(...conditions))
    .orderBy(desc(encounter.occurredOn), desc(encounter.id)).limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    encounters: page.map(encounterOut),
    next_cursor: rows.length > input.limit && last
      ? Buffer.from(`${last.occurredOn}|${last.id}`).toString('base64url') : null,
  };
}
