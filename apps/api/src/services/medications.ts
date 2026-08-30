import {
  and, desc, eq, gte, inArray, isNull, lt, lte, or, sql,
} from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  Medication, MedicationBatchCreateResponse, MedicationBatchRow,
  type MedicationArchiveRequestT, type MedicationBatchCreateRequestT,
  type MedicationListQueryT, type MedicationPatchRequestT, type MedicationT,
} from '@amr/contracts';
import { serverTimestamp } from '@amr/storage';
import { db, type Tx } from '../db/client.js';
import { encounter, medication, person, searchEntry } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { appendJournal } from '../journal.js';
import { recordOperation, replayOperation } from './operation-ledger.js';
import { projectStableSource, stableOriginPage, stableSourcePageOut } from './stable-source.js';

type MedicationRow = typeof medication.$inferSelect;

const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const canonicalOnSql = sql<string>`COALESCE(
  (${medication.administeredAt} at time zone 'UTC')::date,
  ${medication.startedOn}
)`;

function canonicalOn(row: MedicationRow): string {
  return row.administeredAt?.toISOString().slice(0, 10) ?? row.startedOn!;
}

export function medicationOut(row: MedicationRow): MedicationT {
  return Medication.parse({
    id: row.id, person_id: row.personId, client_row_id: row.clientRowId,
    encounter_id: row.encounterId, kind: row.kind, name_raw: row.nameRaw,
    generic_name: row.genericName, dose_raw: row.doseRaw, dose_value: row.doseValue,
    dose_unit: row.doseUnit, concentration_pct: row.concentrationPct,
    solute_mass_g: row.soluteMassG, frequency_raw: row.frequencyRaw, route: row.route,
    administration_group: row.administrationGroup, group_volume_ml: row.groupVolumeMl,
    sequence: row.sequence, administered_at: row.administeredAt?.toISOString() ?? null,
    started_on: row.startedOn, ended_on: row.endedOn,
    source_page: stableSourcePageOut(row), note: row.note,
    canonical_on: canonicalOn(row), canonical_at: row.administeredAt?.toISOString() ?? null,
    time_precision: row.administeredAt ? 'minute' : 'date', source: row.source,
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

async function projectMedicationSearch(
  tx: Tx, row: MedicationRow, sourceRevisionHash: string,
): Promise<void> {
  if (row.archivedAt) {
    await tx.delete(searchEntry).where(and(
      eq(searchEntry.entityType, 'medication'), eq(searchEntry.entityId, row.id),
    ));
    return;
  }
  const occurredOn = canonicalOn(row);
  const body = [
    row.genericName, row.doseRaw,
    row.doseValue === null ? null : `${row.doseValue} ${row.doseUnit ?? ''}`.trim(),
    row.frequencyRaw, row.route, row.administrationGroup, row.note,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n');
  await tx.insert(searchEntry).values({
    id: row.id, personId: row.personId, entityType: 'medication', entityId: row.id,
    documentId: row.currentDocumentId, occurredOn,
    sortAt: row.administeredAt ?? new Date(`${occurredOn}T00:00:00.000Z`),
    title: row.nameRaw, coreBody: body, sourceRevisionHash,
  }).onConflictDoUpdate({
    target: [searchEntry.entityType, searchEntry.entityId],
    set: {
      documentId: row.currentDocumentId, occurredOn,
      sortAt: row.administeredAt ?? new Date(`${occurredOn}T00:00:00.000Z`),
      title: row.nameRaw, coreBody: body, sourceRevisionHash, updatedAt: new Date(),
    },
  });
}

export async function persistMedicationBatch(input: {
  tx: Tx; personId: string; accountId: string; ownerSlug: string;
  body: MedicationBatchCreateRequestT; request: Record<string, unknown>; requestHash: string;
  sourceRefs?: ReadonlyMap<string, Record<string, unknown>>;
}) {
    const tx = input.tx;
    const ids = input.body.medications.map((item) => item.client_row_id);
    const duplicate = (await tx.select({ id: medication.id }).from(medication).where(and(
      eq(medication.personId, input.personId), inArray(medication.clientRowId, ids),
    )).limit(1))[0];
    if (duplicate) throw new ApiError('operation_conflict', '用药 client_row_id 已由另一操作创建');
    const at = serverTimestamp();
    const inserted: MedicationRow[] = [];
    const warnings: Array<{
      row_index: number; client_row_id: string; code: 'source_unavailable'; message: string;
    }> = [];
    for (const [index, value] of input.body.medications.entries()) {
      await assertEncounter(tx, input.personId, value.encounter_id);
      const projected = await projectStableSource(tx, {
        personId: input.personId, sourcePage: value.source_page,
        path: ['medications', index, 'source_page'], entityLabel: 'medication',
      });
      const { warning, ...source } = projected;
      const row = (await tx.insert(medication).values({
        id: uuidv7(), personId: input.personId, clientRowId: value.client_row_id,
        encounterId: value.encounter_id, kind: value.kind, nameRaw: value.name_raw,
        genericName: value.generic_name, doseRaw: value.dose_raw, doseValue: value.dose_value,
        doseUnit: value.dose_unit, concentrationPct: value.concentration_pct,
        soluteMassG: value.solute_mass_g, frequencyRaw: value.frequency_raw, route: value.route,
        administrationGroup: value.administration_group, groupVolumeMl: value.group_volume_ml,
        sequence: value.sequence,
        administeredAt: value.administered_at ? new Date(value.administered_at) : null,
        startedOn: value.started_on, endedOn: value.ended_on, ...source,
        note: value.note, source: 'manual',
        sourceRef: input.sourceRefs?.get(value.client_row_id) ?? null, revision: 1,
        createdBy: input.accountId, createdAt: new Date(at), updatedBy: input.accountId,
        updatedAt: new Date(at), archivedAt: null,
      }).returning())[0]!;
      inserted.push(row);
      if (warning) warnings.push({
        row_index: index, client_row_id: value.client_row_id, code: 'source_unavailable',
        message: '稳定来源已保存，但当前原件页不可用',
      });
      await projectMedicationSearch(tx, row, input.requestHash);
    }
    const response = MedicationBatchCreateResponse.parse({
      medications: inserted.map(medicationOut), warnings,
    });
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'medication_upsert', subjectType: 'medication_batch', subjectId: inserted[0]?.id ?? null,
      personId: input.personId, requestHash: input.requestHash, request: input.request, result: response,
    });
    await appendJournal(tx, input.ownerSlug, {
      schema_version: '1.0', event: 'medication_upsert', event_id: input.body.client_operation_id,
      at, by_account_id: input.accountId, client_operation_id: input.body.client_operation_id,
      person_slug: input.ownerSlug, subject_id: inserted[0]!.id, revision: 1,
      before: [], after: response.medications, correction_note: null,
      operation_replay: { request_hash: input.requestHash, response_snapshot: response }, references: {},
    });
    return response;
}

export async function createMedicationBatch(input: {
  personId: string; accountId: string; body: MedicationBatchCreateRequestT;
}) {
  return db.transaction(async (tx) => {
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, input.personId)).limit(1).for('update'))[0];
    if (!owner) throw notFound();
    const request = { person_id: input.personId, ...input.body };
    const replay = await replayOperation<ReturnType<typeof MedicationBatchCreateResponse.parse>>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return MedicationBatchCreateResponse.parse(replay.result);
    return persistMedicationBatch({
      tx, personId: input.personId, accountId: input.accountId, ownerSlug: owner.slug,
      body: input.body, request, requestHash: replay.requestHash,
    });
  });
}

function patchInput(current: MedicationRow, body: MedicationPatchRequestT) {
  const pick = <T>(key: keyof MedicationPatchRequestT, fallback: T): T =>
    (has(body, key as string) ? body[key] : fallback) as T;
  return MedicationBatchRow.parse({
    client_row_id: current.clientRowId,
    encounter_id: pick('encounter_id', current.encounterId), kind: pick('kind', current.kind),
    name_raw: pick('name_raw', current.nameRaw), generic_name: pick('generic_name', current.genericName),
    dose_raw: pick('dose_raw', current.doseRaw), dose_value: pick('dose_value', current.doseValue),
    dose_unit: pick('dose_unit', current.doseUnit),
    concentration_pct: pick('concentration_pct', current.concentrationPct),
    solute_mass_g: pick('solute_mass_g', current.soluteMassG),
    frequency_raw: pick('frequency_raw', current.frequencyRaw), route: pick('route', current.route),
    administration_group: pick('administration_group', current.administrationGroup),
    group_volume_ml: pick('group_volume_ml', current.groupVolumeMl),
    sequence: pick('sequence', current.sequence),
    administered_at: pick('administered_at', current.administeredAt?.toISOString() ?? null),
    started_on: pick('started_on', current.startedOn), ended_on: pick('ended_on', current.endedOn),
    source_page: has(body, 'source_page') ? body.source_page ?? null : stableOriginPage(current),
    note: pick('note', current.note),
  });
}

async function mutateMedication(input: {
  medicationId: string; accountId: string;
  body: MedicationPatchRequestT | MedicationArchiveRequestT; archive: boolean;
}) {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(medication).where(eq(medication.id, input.medicationId))
      .limit(1).for('update'))[0];
    if (!current) throw notFound();
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, current.personId)).limit(1))[0];
    if (!owner) throw notFound();
    const request = { medication_id: input.medicationId, archive: input.archive, ...input.body };
    const replay = await replayOperation<MedicationT>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return Medication.parse(replay.result);
    if (input.body.if_revision !== current.revision) {
      throw new ApiError('revision_conflict', '用药事实已被其他操作更新', {
        base_revision: input.body.if_revision, current: medicationOut(current), draft: input.body,
      });
    }
    if (current.archivedAt) throw notFound();
    const at = serverTimestamp();
    let row: MedicationRow;
    if (input.archive) {
      row = (await tx.update(medication).set({
        archivedAt: new Date(at), revision: current.revision + 1,
        updatedBy: input.accountId, updatedAt: new Date(at),
      }).where(eq(medication.id, current.id)).returning())[0]!;
    } else {
      const value = patchInput(current, input.body as MedicationPatchRequestT);
      await assertEncounter(tx, current.personId, value.encounter_id);
      const projected = await projectStableSource(tx, {
        personId: current.personId, sourcePage: value.source_page,
        path: ['source_page'], entityLabel: 'medication',
      });
      const { warning: _warning, ...source } = projected;
      row = (await tx.update(medication).set({
        encounterId: value.encounter_id, kind: value.kind, nameRaw: value.name_raw,
        genericName: value.generic_name, doseRaw: value.dose_raw, doseValue: value.dose_value,
        doseUnit: value.dose_unit, concentrationPct: value.concentration_pct,
        soluteMassG: value.solute_mass_g, frequencyRaw: value.frequency_raw, route: value.route,
        administrationGroup: value.administration_group, groupVolumeMl: value.group_volume_ml,
        sequence: value.sequence,
        administeredAt: value.administered_at ? new Date(value.administered_at) : null,
        startedOn: value.started_on, endedOn: value.ended_on, ...source, note: value.note,
        revision: current.revision + 1, updatedBy: input.accountId, updatedAt: new Date(at),
      }).where(eq(medication.id, current.id)).returning())[0]!;
    }
    await projectMedicationSearch(tx, row, replay.requestHash);
    const response = medicationOut(row);
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'medication_upsert', subjectType: 'medication', subjectId: row.id,
      personId: row.personId, requestHash: replay.requestHash, request, result: response,
    });
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'medication_upsert', event_id: input.body.client_operation_id,
      at, by_account_id: input.accountId, client_operation_id: input.body.client_operation_id,
      person_slug: owner.slug, subject_id: row.id, revision: row.revision,
      before: [medicationOut(current)], after: [response], correction_note: input.body.correction_note,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response }, references: {},
    });
    return response;
  });
}

export const patchMedication = (input: {
  medicationId: string; accountId: string; body: MedicationPatchRequestT;
}) => mutateMedication({ ...input, archive: false });

export const archiveMedication = (input: {
  medicationId: string; accountId: string; body: MedicationArchiveRequestT;
}) => mutateMedication({ ...input, archive: true });

type MedicationCursor = { canonical_on: string; administered_at: string | null; id: string };

function decodeCursor(value: string): MedicationCursor {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as MedicationCursor;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cursor.canonical_on) || typeof cursor.id !== 'string'
        || (cursor.administered_at !== null && Number.isNaN(Date.parse(cursor.administered_at)))) throw new Error();
    return cursor;
  } catch {
    throw new ApiError('validation_failed', '用药游标无效');
  }
}

export async function listMedications(input: MedicationListQueryT) {
  const conditions = [eq(medication.personId, input.person_id), isNull(medication.archivedAt)];
  if (input.kind) conditions.push(eq(medication.kind, input.kind));
  if (input.from) conditions.push(gte(canonicalOnSql, input.from));
  if (input.to) conditions.push(lte(canonicalOnSql, input.to));
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    const cursorAt = cursor.administered_at ? new Date(cursor.administered_at) : null;
    conditions.push(or(
      lt(canonicalOnSql, cursor.canonical_on),
      and(eq(canonicalOnSql, cursor.canonical_on), cursorAt
        ? or(
            lt(medication.administeredAt, cursorAt), isNull(medication.administeredAt),
            and(eq(medication.administeredAt, cursorAt), lt(medication.id, cursor.id)),
          )
        : and(isNull(medication.administeredAt), lt(medication.id, cursor.id))),
    )!);
  }
  const rows = await db.select().from(medication).where(and(...conditions))
    .orderBy(desc(canonicalOnSql), sql`${medication.administeredAt} desc nulls last`, desc(medication.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    medications: page.map(medicationOut),
    next_cursor: rows.length > input.limit && last ? Buffer.from(JSON.stringify({
      canonical_on: canonicalOn(last), administered_at: last.administeredAt?.toISOString() ?? null,
      id: last.id,
    })).toString('base64url') : null,
  };
}
