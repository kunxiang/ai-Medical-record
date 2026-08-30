import { createHash } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  MetricGroup, type MetricGroupCreateRequestT, type MetricGroupItemInputT,
  type MetricGroupPatchRequestT, type MetricGroupT,
} from '@amr/contracts';
import { canonicalSeriesIdentity, conceptByCode } from '@amr/medical';
import { serverTimestamp } from '@amr/storage';
import { db, type Tx } from '../db/client.js';
import { metricGroup, metricGroupItem, person } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { appendJournal } from '../journal.js';
import { recordOperation, replayOperation } from './operation-ledger.js';

type GroupRow = typeof metricGroup.$inferSelect;

const selector = (
  conceptCode: string,
  resultKind: 'measured' | 'calculated' = 'measured',
): MetricGroupItemInputT => ({
  item_type: 'series',
  selector: {
    concept_code: conceptCode, qualifier: null, body_site: null, specimen: null,
    method: null, device: null, measurement_setting: null, extra_dims: null,
    result_kind: resultKind,
  },
});

/** Copied on create; changing this preset never mutates an existing L1 group. */
export const THREE_HIGH_PLUS_ITEMS: readonly MetricGroupItemInputT[] = [
  selector('BP_SYSTOLIC'), selector('BP_DIASTOLIC'),
  selector('GLUCOSE'), selector('HBA1C'),
  selector('TOTAL_CHOLESTEROL'), selector('LDL_C'), selector('HDL_C'),
  selector('TRIGLYCERIDES'), selector('URIC_ACID'), selector('BMI', 'calculated'),
];

export function metricSeriesSelectorHash(value: MetricGroupItemInputT['selector']): string {
  return createHash('sha256').update(canonicalSeriesIdentity(value)).digest('hex');
}

function normalizeItems(items: readonly MetricGroupItemInputT[]) {
  const hashes = new Set<string>();
  return items.map((item, position) => {
    const concept = conceptByCode(item.selector.concept_code);
    if (!concept) throw new ApiError('validation_failed', `未知 concept: ${item.selector.concept_code}`);
    const normalized = {
      ...item.selector,
      concept_code: concept.code,
      extra_dims: item.selector.extra_dims
        ? Object.fromEntries(Object.entries(item.selector.extra_dims).sort(([a], [b]) => a.localeCompare(b)))
        : null,
    };
    const hash = metricSeriesSelectorHash(normalized);
    if (hashes.has(hash)) throw new ApiError('validation_failed', '监控组含重复 series selector');
    hashes.add(hash);
    return { id: uuidv7(), position, itemType: 'series' as const, selector: normalized, hash };
  });
}

async function insertItems(
  tx: Tx, groupId: string, items: ReturnType<typeof normalizeItems>,
): Promise<void> {
  if (items.length === 0) return;
  await tx.insert(metricGroupItem).values(items.map((item) => ({
    id: item.id, metricGroupId: groupId, position: item.position, itemType: item.itemType,
    conceptCode: item.selector.concept_code, qualifier: item.selector.qualifier,
    bodySite: item.selector.body_site, specimen: item.selector.specimen,
    method: item.selector.method, device: item.selector.device,
    measurementSetting: item.selector.measurement_setting, extraDims: item.selector.extra_dims,
    resultKind: item.selector.result_kind, seriesSelectorHash: item.hash,
  })));
}

export async function metricGroupOut(tx: Tx, row: GroupRow): Promise<MetricGroupT> {
  const items = await tx.select().from(metricGroupItem)
    .where(eq(metricGroupItem.metricGroupId, row.id))
    .orderBy(metricGroupItem.position, metricGroupItem.id);
  return MetricGroup.parse({
    id: row.id, person_id: row.personId, name: row.name, description: row.description,
    preset_origin: row.presetOrigin, revision: row.revision,
    created_by: row.createdBy, created_at: row.createdAt.toISOString(),
    updated_by: row.updatedBy, updated_at: row.updatedAt.toISOString(),
    archived_at: row.archivedAt?.toISOString() ?? null,
    items: items.map((item) => ({
      id: item.id, position: item.position, item_type: item.itemType,
      selector: {
        concept_code: item.conceptCode, qualifier: item.qualifier, body_site: item.bodySite,
        specimen: item.specimen, method: item.method, device: item.device,
        measurement_setting: item.measurementSetting,
        extra_dims: item.extraDims, result_kind: item.resultKind,
      },
      series_selector_hash: item.seriesSelectorHash,
    })),
  });
}

export async function listMetricGroups(personId: string, includeArchived = false) {
  return db.transaction(async (tx) => {
    const conditions = [eq(metricGroup.personId, personId)];
    if (!includeArchived) conditions.push(isNull(metricGroup.archivedAt));
    const rows = await tx.select().from(metricGroup).where(and(...conditions))
      .orderBy(desc(metricGroup.updatedAt), desc(metricGroup.id));
    const groups: MetricGroupT[] = [];
    for (const row of rows) groups.push(await metricGroupOut(tx, row));
    return { groups };
  });
}

export async function createMetricGroup(input: {
  personId: string; accountId: string; body: MetricGroupCreateRequestT;
}): Promise<MetricGroupT> {
  return db.transaction(async (tx) => {
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, input.personId)).limit(1).for('update'))[0];
    if (!owner) throw notFound();
    const request = { person_id: input.personId, ...input.body };
    const replay = await replayOperation<MetricGroupT>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return MetricGroup.parse(replay.result);
    const itemInputs = input.body.preset === 'three_high_plus'
      ? THREE_HIGH_PLUS_ITEMS : input.body.items!;
    const items = normalizeItems(itemInputs);
    const at = serverTimestamp();
    const row = (await tx.insert(metricGroup).values({
      id: uuidv7(), personId: input.personId, name: input.body.name,
      description: input.body.description, presetOrigin: input.body.preset,
      revision: 1, createdBy: input.accountId, updatedBy: input.accountId,
      createdAt: new Date(at), updatedAt: new Date(at),
    }).returning())[0]!;
    await insertItems(tx, row.id, items);
    const response = await metricGroupOut(tx, row);
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'metric_group_upsert', subjectType: 'metric_group', subjectId: row.id,
      personId: row.personId, requestHash: replay.requestHash, request, result: response,
    });
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'metric_group_upsert',
      event_id: input.body.client_operation_id, at, by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: owner.slug,
      subject_id: row.id, revision: row.revision, before: null, after: response,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response },
      references: {},
    });
    return response;
  });
}

export async function patchMetricGroup(input: {
  groupId: string; accountId: string; body: MetricGroupPatchRequestT;
}): Promise<MetricGroupT> {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(metricGroup)
      .where(eq(metricGroup.id, input.groupId)).limit(1).for('update'))[0];
    if (!current) throw notFound();
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, current.personId)).limit(1))[0];
    if (!owner) throw notFound();
    const request = { metric_group_id: input.groupId, ...input.body };
    const replay = await replayOperation<MetricGroupT>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return MetricGroup.parse(replay.result);
    const before = await metricGroupOut(tx, current);
    if (input.body.if_revision !== current.revision) {
      throw new ApiError('revision_conflict', '监控组已被其他操作更新', {
        base_revision: input.body.if_revision, current: before, draft: input.body,
      });
    }
    const items = input.body.items ? normalizeItems(input.body.items) : null;
    const at = serverTimestamp();
    const row = (await tx.update(metricGroup).set({
      name: input.body.name ?? current.name,
      description: Object.prototype.hasOwnProperty.call(input.body, 'description')
        ? input.body.description! : current.description,
      revision: current.revision + 1, updatedBy: input.accountId, updatedAt: new Date(at),
    }).where(eq(metricGroup.id, current.id)).returning())[0]!;
    if (items) {
      await tx.delete(metricGroupItem).where(eq(metricGroupItem.metricGroupId, row.id));
      await insertItems(tx, row.id, items);
    }
    const response = await metricGroupOut(tx, row);
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'metric_group_upsert', subjectType: 'metric_group', subjectId: row.id,
      personId: row.personId, requestHash: replay.requestHash, request, result: response,
    });
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'metric_group_upsert',
      event_id: input.body.client_operation_id, at, by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: owner.slug,
      subject_id: row.id, revision: row.revision, before, after: response,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response },
      references: {},
    });
    return response;
  });
}

export async function archiveMetricGroup(input: {
  groupId: string; accountId: string;
  body: { client_operation_id: string; if_revision: number };
}): Promise<MetricGroupT> {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(metricGroup)
      .where(eq(metricGroup.id, input.groupId)).limit(1).for('update'))[0];
    if (!current) throw notFound();
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, current.personId)).limit(1))[0];
    if (!owner) throw notFound();
    const request = { metric_group_id: input.groupId, ...input.body };
    const replay = await replayOperation<MetricGroupT>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return MetricGroup.parse(replay.result);
    const before = await metricGroupOut(tx, current);
    if (input.body.if_revision !== current.revision) {
      throw new ApiError('revision_conflict', '监控组已被其他操作更新', {
        base_revision: input.body.if_revision, current: before, draft: input.body,
      });
    }
    const at = serverTimestamp();
    const row = (await tx.update(metricGroup).set({
      archivedAt: new Date(at), revision: current.revision + 1,
      updatedBy: input.accountId, updatedAt: new Date(at),
    }).where(eq(metricGroup.id, current.id)).returning())[0]!;
    const response = await metricGroupOut(tx, row);
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'metric_group_archive', subjectType: 'metric_group', subjectId: row.id,
      personId: row.personId, requestHash: replay.requestHash, request, result: response,
    });
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'metric_group_archive',
      event_id: input.body.client_operation_id, at, by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: owner.slug,
      subject_id: row.id, revision: row.revision, before, after: response,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response },
      references: {},
    });
    return response;
  });
}
