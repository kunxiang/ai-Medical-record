import { createHash } from 'node:crypto';
import {
  and, asc, count, eq, gt, inArray, isNull, max, min, sql,
} from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  ConceptAliasDecision, ObservationMappingInboxResponse, ObservationMappingResolveResponse,
  type ConceptAliasDecisionT, type ObservationMappingResolveRequestT,
} from '@amr/contracts';
import {
  CONCEPT_CATALOG_VERSION, canonicalSeriesIdentity, conceptByCode,
} from '@amr/medical';
import { serverTimestamp } from '@amr/storage';
import { db, type Tx } from '../db/client.js';
import { conceptAliasDecision, observation, person } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { appendJournal } from '../journal.js';
import {
  observationOut, conceptAliasFingerprint, projectObservationSearch,
} from './observations.js';
import { recordOperation, replayOperation } from './operation-ledger.js';
import { rebuildDerivedObservations } from './observation-derivations.js';

type AliasRow = typeof conceptAliasDecision.$inferSelect;
type ObservationRow = typeof observation.$inferSelect;

export function conceptAliasOut(row: AliasRow): ConceptAliasDecisionT {
  return ConceptAliasDecision.parse({
    id: row.id, person_id: row.personId, input_fingerprint: row.inputFingerprint,
    local_name: row.localName, context: row.context, concept_code: row.conceptCode,
    display_name: row.displayName, catalog_version: row.catalogVersion, state: row.state,
    revision: row.revision, decided_by: row.decidedBy,
    decided_at: row.decidedAt.toISOString(), updated_at: row.updatedAt.toISOString(),
  });
}

function catalogSnapshot(code: string, version: string) {
  const concept = conceptByCode(code);
  if (!concept || version !== CONCEPT_CATALOG_VERSION) {
    throw new ApiError('validation_failed', 'concept 或 catalog version 无效');
  }
  return { ...concept, aliases: [...concept.aliases], catalog_version: CONCEPT_CATALOG_VERSION };
}

function seriesKey(row: ObservationRow, conceptCode: string): string {
  return createHash('sha256').update(canonicalSeriesIdentity({
    concept_code: conceptCode, qualifier: row.qualifier, body_site: row.bodySite,
    specimen: row.specimen, method: row.method, device: row.device,
    measurement_setting: row.measurementSetting,
    extra_dims: row.extraDims as Record<string, string> | null, result_kind: row.resultKind as any,
  })).digest('hex');
}

async function writeAlias(input: {
  tx: Tx; personId: string; accountId: string; clientOperationId: string;
  localName: string; context: { specimen: string | null; method: string | null };
  conceptCode: string; catalogVersion: string; existing?: AliasRow;
}): Promise<{ before: ConceptAliasDecisionT | null; after: ConceptAliasDecisionT }> {
  const concept = catalogSnapshot(input.conceptCode, input.catalogVersion);
  const now = new Date(serverTimestamp());
  const fp = conceptAliasFingerprint(input.localName, input.context.specimen, input.context.method);
  const current = input.existing ?? (await input.tx.select().from(conceptAliasDecision).where(and(
    eq(conceptAliasDecision.personId, input.personId),
    eq(conceptAliasDecision.inputFingerprint, fp),
    eq(conceptAliasDecision.state, 'confirmed'),
  )).limit(1).for('update'))[0];
  const before = current ? conceptAliasOut(current) : null;
  const row = current
    ? (await input.tx.update(conceptAliasDecision).set({
      conceptCode: concept.code, displayName: concept.display_name,
      catalogVersion: concept.catalog_version, revision: current.revision + 1,
      decidedBy: input.accountId, decidedAt: now, updatedAt: now,
    }).where(eq(conceptAliasDecision.id, current.id)).returning())[0]!
    : (await input.tx.insert(conceptAliasDecision).values({
      id: uuidv7(), personId: input.personId, inputFingerprint: fp,
      localName: input.localName, context: input.context, conceptCode: concept.code,
      displayName: concept.display_name, catalogVersion: concept.catalog_version,
      state: 'confirmed', revision: 1, decidedBy: input.accountId,
      decidedAt: now, updatedAt: now,
    }).returning())[0]!;
  return { before, after: conceptAliasOut(row) };
}

export async function upsertConceptAlias(input: {
  personId: string; accountId: string; body: {
    client_operation_id: string; local_name: string;
    context: { specimen: string | null; method: string | null };
    concept_code: string; catalog_version: string;
  };
}) {
  return db.transaction(async (tx) => {
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, input.personId)).limit(1).for('update'))[0];
    if (!owner) throw notFound();
    const request = { person_id: input.personId, ...input.body };
    const replay = await replayOperation<ConceptAliasDecisionT>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return ConceptAliasDecision.parse(replay.result);
    const saved = await writeAlias({
      tx, personId: input.personId, accountId: input.accountId,
      clientOperationId: input.body.client_operation_id, localName: input.body.local_name,
      context: input.body.context, conceptCode: input.body.concept_code,
      catalogVersion: input.body.catalog_version,
    });
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'concept_alias_upsert', subjectType: 'concept_alias', subjectId: saved.after.id,
      personId: input.personId, requestHash: replay.requestHash, request, result: saved.after,
    });
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'concept_alias_upsert',
      event_id: input.body.client_operation_id, at: serverTimestamp(), by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: owner.slug,
      subject_id: saved.after.id, revision: saved.after.revision,
      before: saved.before, after: saved.after, observations_before: [], observations_after: [],
      operation_replay: { request_hash: replay.requestHash, response_snapshot: saved.after },
      references: { concept: catalogSnapshot(input.body.concept_code, input.body.catalog_version) },
    });
    return saved.after;
  });
}

export async function patchConceptAlias(input: {
  aliasId: string; accountId: string; body: {
    client_operation_id: string; if_revision: number; concept_code: string; catalog_version: string;
  };
}) {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(conceptAliasDecision)
      .where(eq(conceptAliasDecision.id, input.aliasId)).limit(1).for('update'))[0];
    if (!current) throw notFound();
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, current.personId)).limit(1))[0];
    if (!owner) throw notFound();
    const request = { alias_id: input.aliasId, ...input.body };
    const replay = await replayOperation<ConceptAliasDecisionT>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return ConceptAliasDecision.parse(replay.result);
    if (input.body.if_revision !== current.revision) {
      throw new ApiError('revision_conflict', 'concept alias 已被更新', {
        base_revision: input.body.if_revision, current: conceptAliasOut(current), draft: input.body,
      });
    }
    const saved = await writeAlias({
      tx, personId: current.personId, accountId: input.accountId,
      clientOperationId: input.body.client_operation_id, localName: current.localName,
      context: current.context as { specimen: string | null; method: string | null },
      conceptCode: input.body.concept_code, catalogVersion: input.body.catalog_version,
      existing: current,
    });
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'concept_alias_upsert', subjectType: 'concept_alias', subjectId: saved.after.id,
      personId: current.personId, requestHash: replay.requestHash, request, result: saved.after,
    });
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'concept_alias_upsert',
      event_id: input.body.client_operation_id, at: serverTimestamp(), by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: owner.slug,
      subject_id: saved.after.id, revision: saved.after.revision,
      before: saved.before, after: saved.after, observations_before: [], observations_after: [],
      operation_replay: { request_hash: replay.requestHash, response_snapshot: saved.after },
      references: { concept: catalogSnapshot(input.body.concept_code, input.body.catalog_version) },
    });
    return saved.after;
  });
}

export async function listObservationMappingInbox(input: {
  personId: string; cursor?: string; limit: number;
}) {
  const conditions = [
    eq(observation.personId, input.personId), isNull(observation.conceptCode),
    isNull(observation.archivedAt),
  ];
  if (input.cursor) conditions.push(gt(observation.mappingFingerprint, input.cursor));
  const rows = await db.select({
    inputFingerprint: observation.mappingFingerprint,
    localName: min(observation.localName), specimen: min(observation.specimen),
    method: min(observation.method), count: count(),
    firstObservedOn: min(observation.observedOn), latestObservedOn: max(observation.observedOn),
    observationIds: sql<string[]>`(array_agg(${observation.id} order by ${observation.observedOn} desc, ${observation.id} desc))[1:100]`,
  }).from(observation).where(and(...conditions)).groupBy(observation.mappingFingerprint)
    .orderBy(asc(observation.mappingFingerprint)).limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return ObservationMappingInboxResponse.parse({
    items: page.map((row) => ({
      input_fingerprint: row.inputFingerprint, local_name: row.localName,
      context: { specimen: row.specimen, method: row.method }, count: row.count,
      first_observed_on: row.firstObservedOn, latest_observed_on: row.latestObservedOn,
      observation_ids: row.observationIds,
    })),
    next_cursor: rows.length > input.limit && last ? last.inputFingerprint : null,
  });
}

export async function resolveObservationMapping(input: {
  personId: string; accountId: string; body: ObservationMappingResolveRequestT;
}) {
  return db.transaction(async (tx) => {
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, input.personId)).limit(1).for('update'))[0];
    if (!owner) throw notFound();
    const request = { person_id: input.personId, ...input.body };
    const replay = await replayOperation<ReturnType<typeof ObservationMappingResolveResponse.parse>>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return ObservationMappingResolveResponse.parse(replay.result);
    const concept = catalogSnapshot(input.body.concept_code, input.body.catalog_version);
    const requested = new Map(input.body.rows.map((row) => [row.observation_id, row.if_revision]));
    const targets = input.body.mode === 'same_fingerprint'
      ? await tx.select().from(observation).where(and(
        eq(observation.personId, input.personId),
        eq(observation.mappingFingerprint, input.body.input_fingerprint),
        isNull(observation.conceptCode), isNull(observation.archivedAt),
      )).orderBy(asc(observation.id)).for('update')
      : await tx.select().from(observation).where(and(
        eq(observation.personId, input.personId),
        inArray(observation.id, [...requested.keys()]), isNull(observation.archivedAt),
      )).orderBy(asc(observation.id)).for('update');
    if (targets.length !== requested.size || targets.some((row) => !requested.has(row.id))) {
      throw new ApiError('validation_failed', 'resolve rows 必须完整匹配目标 observation');
    }
    if (targets.some((row) => row.mappingFingerprint !== input.body.input_fingerprint)) {
      throw new ApiError('validation_failed', '目标 observation 不属于该 fingerprint');
    }
    const conflicts = targets.filter((row) => requested.get(row.id) !== row.revision).map((row) => ({
      observation_id: row.id, base_revision: requested.get(row.id),
      current: observationOut(row),
    }));
    if (conflicts.length > 0) {
      throw new ApiError('revision_conflict', '部分 observation 已被更新', { conflicts });
    }
    const aliasSaved = await writeAlias({
      tx, personId: input.personId, accountId: input.accountId,
      clientOperationId: input.body.client_operation_id, localName: input.body.local_name,
      context: input.body.context, conceptCode: input.body.concept_code,
      catalogVersion: input.body.catalog_version,
    });
    const before = targets.map(observationOut);
    const after = [];
    const now = new Date(serverTimestamp());
    for (const target of targets) {
      const row = (await tx.update(observation).set({
        conceptCode: concept.code, conceptCatalogVersion: concept.catalog_version,
        loincCode: concept.loinc_code, seriesKey: seriesKey(target, concept.code),
        reviewStatus: 'corrected', reviewedBy: input.accountId, reviewedAt: now,
        revision: target.revision + 1, updatedBy: input.accountId, updatedAt: now,
      }).where(eq(observation.id, target.id)).returning())[0]!;
      const output = observationOut(row);
      after.push(output);
      await projectObservationSearch(tx, output, replay.requestHash);
    }
    const selectors = [...new Map(after.map((row) => [row.series_key, {
      concept_code: row.concept_code!, qualifier: row.qualifier, body_site: row.body_site,
      specimen: row.specimen, method: row.method, device: row.device,
      measurement_setting: row.measurement_setting, extra_dims: row.extra_dims,
      result_kind: row.result_kind, series_key: row.series_key!,
    }])).values()];
    const response = ObservationMappingResolveResponse.parse({
      alias: aliasSaved.after, observations: after, series_selectors: selectors,
    });
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'concept_alias_upsert', subjectType: 'concept_alias', subjectId: aliasSaved.after.id,
      personId: input.personId, requestHash: replay.requestHash, request, result: response,
    });
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'concept_alias_upsert',
      event_id: input.body.client_operation_id, at: serverTimestamp(), by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: owner.slug,
      subject_id: aliasSaved.after.id, revision: aliasSaved.after.revision,
      before: aliasSaved.before, after: aliasSaved.after,
      observations_before: before, observations_after: after,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response },
      references: { concept },
    });
    await rebuildDerivedObservations(tx, input.personId);
    return response;
  });
}

export async function conceptAliasPersonId(aliasId: string): Promise<string> {
  const row = (await db.select({ personId: conceptAliasDecision.personId })
    .from(conceptAliasDecision).where(eq(conceptAliasDecision.id, aliasId)).limit(1))[0];
  if (!row) throw notFound();
  return row.personId;
}
