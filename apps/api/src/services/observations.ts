import { createHash } from 'node:crypto';
import {
  and, desc, eq, gte, ilike, isNotNull, isNull, lt, lte, or,
} from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  MedicalConcept, Observation, ObservationBatchCreateResponse, ObservationBatchDefaults,
  type ObservationArchiveRequestT, type ObservationBatchCreateRequestT,
  type ObservationBatchRowT, type ObservationListQueryT, type ObservationPatchRequestT,
  type ObservationT,
} from '@amr/contracts';
import {
  CONCEPT_CATALOG_VERSION, canonicalSeriesIdentity, canonicalUcum, conceptByCode,
  convertToSi, observationConsistencyFlags, parseResultValue,
} from '@amr/medical';
import { canonicalJson, serverTimestamp } from '@amr/storage';
import { db, type Tx } from '../db/client.js';
import {
  conceptAliasDecision, document, encounter, facility, observation, person, searchEntry,
} from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { appendJournal } from '../journal.js';
import { recordOperation, replayOperation } from './operation-ledger.js';
import { rebuildDerivedObservations } from './observation-derivations.js';
import { projectStableSource, stableOriginPage, stableSourcePageOut } from './stable-source.js';

type ObservationRow = typeof observation.$inferSelect;

const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function validation(path: Array<string | number>, message: string): never {
  throw new ApiError('validation_failed', 'observation 校验失败', {
    issues: [{ code: 'custom', path, message }],
  });
}

function medicalConceptOut(code: string) {
  const concept = conceptByCode(code);
  if (!concept) return null;
  return MedicalConcept.parse({ ...concept, aliases: [...concept.aliases], catalog_version: CONCEPT_CATALOG_VERSION });
}

export function observationOut(row: ObservationRow): ObservationT {
  return Observation.parse({
    id: row.id, person_id: row.personId, document_id: row.documentId,
    encounter_id: row.encounterId, client_row_id: row.clientRowId,
    observed_on: row.observedOn, observed_at: row.observedAt?.toISOString() ?? null,
    time_precision: row.timePrecision, date_source: row.dateSource,
    local_name: row.localName, concept_code: row.conceptCode,
    concept_catalog_version: row.conceptCatalogVersion, loinc_code: row.loincCode,
    qualifier: row.qualifier, body_site: row.bodySite, extra_dims: row.extraDims,
    series_key: row.seriesKey, value_raw: row.valueRaw, value_num: row.valueNum,
    comparator: row.comparator, value_text: row.valueText,
    value_dimensions: row.valueDimensions, unit_raw: row.unitRaw, unit_ucum: row.unitUcum,
    value_si: row.valueSi, unit_si: row.unitSi, conversion_version: row.conversionVersion,
    ref_low: row.refLow, ref_high: row.refHigh, ref_text: row.refText, ref_unit: row.refUnit,
    abnormal_flag_raw: row.abnormalFlagRaw, abnormal_flag: row.abnormalFlag,
    specimen: row.specimen, specimen_label: row.specimenLabel, method: row.method,
    device: row.device, measurement_setting: row.measurementSetting, result_kind: row.resultKind,
    collected_at: row.collectedAt?.toISOString() ?? null,
    reported_at: row.reportedAt?.toISOString() ?? null, lab_facility_id: row.labFacilityId,
    mapping_status: row.conceptCode ? 'mapped' : 'unmapped', source_page: stableSourcePageOut(row),
    source: row.source, source_ref: row.sourceRef, review_status: row.reviewStatus,
    reviewed_by: row.reviewedBy, reviewed_at: row.reviewedAt?.toISOString() ?? null,
    consistency_flags: row.consistencyFlags, is_derived: row.isDerived,
    derived_formula: row.derivedFormula, calculation_version: row.calculationVersion,
    derivation_key: row.derivationKey, input_observation_ids: row.inputObservationIds,
    input_revision_hash: row.inputRevisionHash, revision: row.revision,
    created_by: row.createdBy, created_at: row.createdAt.toISOString(),
    updated_by: row.updatedBy, updated_at: row.updatedAt.toISOString(),
    archived_at: row.archivedAt?.toISOString() ?? null,
  });
}

export function conceptAliasFingerprint(
  localName: string, specimen: string | null, method: string | null,
): string {
  return createHash('sha256').update(canonicalJson({
    local_name: localName.normalize('NFKC').trim().toLocaleLowerCase('zh-CN'), specimen, method,
  })).digest('hex');
}

async function assertOptionalReferences(tx: Tx, input: {
  personId: string; documentId: string | null; encounterId: string | null; labFacilityId: string | null;
}): Promise<void> {
  if (input.documentId) {
    const row = (await tx.select({ id: document.id }).from(document).where(and(
      eq(document.id, input.documentId), eq(document.personId, input.personId), isNull(document.archivedAt),
    )).limit(1))[0];
    if (!row) throw notFound();
  }
  if (input.encounterId) {
    const row = (await tx.select({ id: encounter.id }).from(encounter).where(and(
      eq(encounter.id, input.encounterId), eq(encounter.personId, input.personId), isNull(encounter.archivedAt),
    )).limit(1))[0];
    if (!row) throw notFound();
  }
  if (input.labFacilityId) {
    const row = (await tx.select({ id: facility.id }).from(facility)
      .where(eq(facility.id, input.labFacilityId)).limit(1))[0];
    if (!row) throw notFound();
  }
}

type NormalizedFact = Omit<typeof observation.$inferInsert, 'id' | 'personId' | 'createdAt' | 'updatedAt'> & {
  warnings: Array<'unknown_unit' | 'unmapped_concept' | 'source_unavailable'>;
  conceptReference: ReturnType<typeof medicalConceptOut>;
};

async function normalizeFact(tx: Tx, input: {
  personId: string; accountId: string; row: ObservationBatchRowT;
  defaults: ObservationBatchCreateRequestT['defaults']; path: Array<string | number>;
  existing?: ObservationRow;
  source?: 'manual' | 'imported' | 'accepted_suggestion';
  sourceRef?: Record<string, unknown> | null;
}): Promise<NormalizedFact> {
  const value = input.row;
  const base = input.existing;
  const documentId = has(value, 'document_id') ? value.document_id ?? null
    : input.defaults.document_id ?? base?.documentId ?? null;
  const encounterId = has(value, 'encounter_id') ? value.encounter_id ?? null
    : input.defaults.encounter_id ?? base?.encounterId ?? null;
  const observedOn = value.observed_on ?? input.defaults.observed_on ?? base?.observedOn;
  if (!observedOn) validation([...input.path, 'observed_on'], 'observed_on 必填');
  const observedAtRaw = has(value, 'observed_at') ? value.observed_at ?? null
    : input.defaults.observed_at ?? (base?.observedAt?.toISOString() ?? null);
  const timePrecision = value.time_precision ?? input.defaults.time_precision ?? base?.timePrecision ?? 'date';
  if (timePrecision === 'minute' && !observedAtRaw) {
    validation([...input.path, 'observed_at'], 'minute 精度必须提供 observed_at');
  }
  if (timePrecision !== 'minute' && observedAtRaw) {
    validation([...input.path, 'observed_at'], '仅 minute 精度可保存 observed_at');
  }
  const dateSource = value.date_source ?? input.defaults.date_source ?? base?.dateSource ?? 'manual';
  const specimen = has(value, 'specimen') ? value.specimen ?? null
    : input.defaults.specimen ?? base?.specimen ?? null;
  const specimenLabel = has(value, 'specimen_label') ? value.specimen_label ?? null
    : input.defaults.specimen_label ?? base?.specimenLabel ?? null;
  const method = has(value, 'method') ? value.method ?? null : input.defaults.method ?? base?.method ?? null;
  const device = has(value, 'device') ? value.device ?? null : input.defaults.device ?? base?.device ?? null;
  const measurementSetting = has(value, 'measurement_setting') ? value.measurement_setting ?? null
    : input.defaults.measurement_setting ?? base?.measurementSetting ?? null;
  const collectedAt = has(value, 'collected_at') ? value.collected_at ?? null
    : input.defaults.collected_at ?? (base?.collectedAt?.toISOString() ?? null);
  const reportedAt = has(value, 'reported_at') ? value.reported_at ?? null
    : input.defaults.reported_at ?? (base?.reportedAt?.toISOString() ?? null);
  const labFacilityId = has(value, 'lab_facility_id') ? value.lab_facility_id ?? null
    : input.defaults.lab_facility_id ?? base?.labFacilityId ?? null;
  await assertOptionalReferences(tx, { personId: input.personId, documentId, encounterId, labFacilityId });

  let conceptCode = value.concept_code ?? null;
  let conceptReference = conceptCode ? medicalConceptOut(conceptCode) : null;
  if (conceptCode && !conceptReference) validation([...input.path, 'concept_code'], 'concept 不在当前版本目录中');
  if (conceptReference && value.concept_catalog_version !== CONCEPT_CATALOG_VERSION) {
    validation([...input.path, 'concept_catalog_version'], 'catalog version 与当前 concept snapshot 不匹配');
  }
  if (!conceptCode) {
    const fp = conceptAliasFingerprint(value.local_name, specimen, method);
    const alias = (await tx.select().from(conceptAliasDecision).where(and(
      eq(conceptAliasDecision.personId, input.personId),
      eq(conceptAliasDecision.inputFingerprint, fp),
      eq(conceptAliasDecision.state, 'confirmed'),
    )).limit(1))[0];
    if (alias) {
      conceptCode = alias.conceptCode;
      conceptReference = medicalConceptOut(conceptCode);
    }
  }
  const parsed = parseResultValue(value.value_raw);
  const valueNum = value.value_num ?? (parsed.kind === 'numeric' ? parsed.value : null);
  const comparator = value.comparator ?? (parsed.kind === 'numeric' ? parsed.comparator : null);
  const valueText = value.value_text ?? (parsed.kind === 'text' ? parsed.text : null);
  let unitUcum = value.unit_ucum ? canonicalUcum(value.unit_ucum) : null;
  if (!unitUcum && value.unit_raw) unitUcum = canonicalUcum(value.unit_raw);
  const converted = conceptCode && valueNum !== null && unitUcum
    ? convertToSi(conceptCode, valueNum, unitUcum) : null;
  const seriesKey = conceptCode ? createHash('sha256').update(canonicalSeriesIdentity({
    concept_code: conceptCode, qualifier: value.qualifier, body_site: value.body_site,
    specimen, method, device, measurement_setting: measurementSetting,
    extra_dims: value.extra_dims, result_kind: value.result_kind,
  })).digest('hex') : null;
  const sourceInput = value.source_page ?? (base ? stableOriginPage(base) : null);
  const projectedSource = await projectStableSource(tx, {
    personId: input.personId, sourcePage: sourceInput, path: [...input.path, 'source_page'],
    entityLabel: 'observation',
  });
  const { warning: sourceUnavailable, ...source } = projectedSource;
  const consistencyFlags = observationConsistencyFlags({
    value_raw: value.value_raw, value_num: valueNum, unit_raw: value.unit_raw,
    ref_low: value.ref_low, ref_high: value.ref_high,
  });
  const warnings: NormalizedFact['warnings'] = [];
  if (!conceptCode) warnings.push('unmapped_concept');
  if (value.unit_raw && !unitUcum) warnings.push('unknown_unit');
  if (sourceUnavailable) warnings.push('source_unavailable');
  const at = new Date(serverTimestamp());
  return {
    documentId, encounterId, clientRowId: value.client_row_id,
    observedOn, observedAt: observedAtRaw ? new Date(observedAtRaw) : null,
    timePrecision, dateSource, localName: value.local_name,
    mappingFingerprint: conceptAliasFingerprint(value.local_name, specimen, method), conceptCode,
    conceptCatalogVersion: conceptReference ? CONCEPT_CATALOG_VERSION : null,
    loincCode: conceptReference?.loinc_code ?? null, qualifier: value.qualifier,
    bodySite: value.body_site, extraDims: value.extra_dims, seriesKey,
    valueRaw: value.value_raw, valueNum, comparator, valueText,
    valueDimensions: value.value_dimensions, unitRaw: value.unit_raw, unitUcum,
    valueSi: converted?.value ?? null, unitSi: converted?.unit ?? null,
    conversionVersion: converted?.version ?? null, refLow: value.ref_low, refHigh: value.ref_high,
    refText: value.ref_text, refUnit: value.ref_unit, abnormalFlagRaw: value.abnormal_flag_raw,
    abnormalFlag: value.abnormal_flag, specimen, specimenLabel, method, device,
    measurementSetting, resultKind: value.result_kind,
    collectedAt: collectedAt ? new Date(collectedAt) : null,
    reportedAt: reportedAt ? new Date(reportedAt) : null, labFacilityId,
    ...source, source: base?.source ?? input.source ?? 'manual',
    sourceRef: base?.sourceRef ?? input.sourceRef ?? null,
    reviewStatus: base ? 'corrected' : 'confirmed', reviewedBy: input.accountId,
    reviewedAt: at, consistencyFlags, isDerived: base?.isDerived ?? false,
    derivedFormula: base?.derivedFormula ?? null, calculationVersion: base?.calculationVersion ?? null,
    derivationKey: base?.derivationKey ?? null,
    inputObservationIds: base?.inputObservationIds ?? null,
    inputRevisionHash: base?.inputRevisionHash ?? null,
    revision: base ? base.revision + 1 : 1, createdBy: base?.createdBy ?? input.accountId,
    updatedBy: input.accountId, archivedAt: base?.archivedAt ?? null,
    warnings, conceptReference,
  };
}

export async function projectObservationSearch(
  tx: Tx, value: ObservationT, requestHash: string,
): Promise<void> {
  if (value.archived_at) {
    await tx.delete(searchEntry).where(and(
      eq(searchEntry.entityType, 'observation'), eq(searchEntry.entityId, value.id),
    ));
    return;
  }
  const body = [
    value.concept_code, value.value_raw, value.unit_raw, value.ref_text,
    value.specimen, value.specimen_label, value.method, value.device,
  ].filter(Boolean).join('\n');
  await tx.insert(searchEntry).values({
    id: value.id, personId: value.person_id, entityType: 'observation', entityId: value.id,
    documentId: value.document_id, occurredOn: value.observed_on,
    sortAt: value.observed_at ? new Date(value.observed_at) : new Date(`${value.observed_on}T00:00:00.000Z`),
    title: value.local_name, coreBody: body, sourceRevisionHash: requestHash,
  }).onConflictDoUpdate({
    target: [searchEntry.entityType, searchEntry.entityId],
    set: {
      documentId: value.document_id, occurredOn: value.observed_on,
      sortAt: value.observed_at ? new Date(value.observed_at) : new Date(`${value.observed_on}T00:00:00.000Z`),
      title: value.local_name, coreBody: body, sourceRevisionHash: requestHash, updatedAt: new Date(),
    },
  });
}

async function facilitySnapshots(tx: Tx, ids: Array<string | null>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const snapshots = [];
  for (const id of unique) {
    const row = (await tx.select().from(facility).where(eq(facility.id, id)).limit(1))[0];
    if (!row) throw notFound();
    snapshots.push(row);
  }
  return snapshots;
}

export async function persistObservationBatch(input: {
  tx: Tx; personId: string; accountId: string; ownerSlug: string;
  body: ObservationBatchCreateRequestT; request: Record<string, unknown>; requestHash: string;
  source?: 'manual' | 'imported' | 'accepted_suggestion';
  sourceRefs?: ReadonlyMap<string, Record<string, unknown>>;
  suggestionSnapshot?: Record<string, unknown> | null;
}) {
  const existing = await input.tx.select({ clientRowId: observation.clientRowId })
    .from(observation).where(and(
      eq(observation.personId, input.personId),
      or(...input.body.observations.map((row) => eq(observation.clientRowId, row.client_row_id)))!,
    ));
  if (existing.length > 0) {
    validation(['observations'], 'client_row_id 已存在且不属于本次 operation replay');
  }
  const saved: ObservationT[] = [];
  const warnings: Array<{
    row_index: number; client_row_id: string;
    code: NormalizedFact['warnings'][number]; message: string;
  }> = [];
  const concepts = new Map<string, NonNullable<NormalizedFact['conceptReference']>>();
  for (const [index, row] of input.body.observations.entries()) {
    const normalized = await normalizeFact(input.tx, {
      personId: input.personId, accountId: input.accountId, row,
      defaults: input.body.defaults, path: ['observations', index], source: input.source,
      sourceRef: input.sourceRefs?.get(row.client_row_id) ?? null,
    });
    const { warnings: rowWarnings, conceptReference, ...values } = normalized;
    const inserted = (await input.tx.insert(observation).values({
      id: uuidv7(), personId: input.personId, ...values,
    }).returning())[0]!;
    const output = observationOut(inserted);
    saved.push(output);
    if (conceptReference) concepts.set(conceptReference.code, conceptReference);
    for (const code of rowWarnings) warnings.push({
      row_index: index, client_row_id: row.client_row_id, code,
      message: code === 'unknown_unit' ? '单位未识别，已保留原值'
        : code === 'unmapped_concept' ? '指标尚未映射，已进入整理队列'
          : '原件当前不可用，事实与稳定来源仍已保存',
    });
    await projectObservationSearch(input.tx, output, input.requestHash);
  }
  const response = ObservationBatchCreateResponse.parse({ observations: saved, warnings });
  await recordOperation(input.tx, {
    accountId: input.accountId, clientOperationId: input.body.client_operation_id,
    kind: 'observation_upsert', subjectType: 'observation', subjectId: saved[0]!.id,
    personId: input.personId, requestHash: input.requestHash, request: input.request, result: response,
  });
  const facilities = await facilitySnapshots(
    input.tx, saved.map((item) => item.lab_facility_id),
  );
  await appendJournal(input.tx, input.ownerSlug, {
    schema_version: '1.0', event: 'observation_upsert',
    event_id: input.body.client_operation_id, at: serverTimestamp(), by_account_id: input.accountId,
    client_operation_id: input.body.client_operation_id, person_slug: input.ownerSlug,
    subject_id: saved[0]!.id, revision: 1, before: [], after: saved,
    correction_note: null,
    operation_replay: { request_hash: input.requestHash, response_snapshot: response },
    references: {
      concepts: [...concepts.values()], facilities,
      suggestion: input.suggestionSnapshot ?? null,
    },
  });
  await rebuildDerivedObservations(input.tx, input.personId);
  return response;
}

export async function createObservationBatch(input: {
  personId: string; accountId: string; body: ObservationBatchCreateRequestT;
}) {
  return db.transaction(async (tx) => {
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, input.personId)).limit(1).for('update'))[0];
    if (!owner) throw notFound();
    const request = { person_id: input.personId, ...input.body };
    const replay = await replayOperation<ReturnType<typeof ObservationBatchCreateResponse.parse>>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return ObservationBatchCreateResponse.parse(replay.result);
    return persistObservationBatch({
      tx, personId: input.personId, accountId: input.accountId, ownerSlug: owner.slug,
      body: input.body, request, requestHash: replay.requestHash,
    });
  });
}

export async function listObservations(input: ObservationListQueryT) {
  const conditions = [eq(observation.personId, input.person_id), isNull(observation.archivedAt)];
  if (input.concept_code) conditions.push(eq(observation.conceptCode, input.concept_code));
  if (input.local_name) conditions.push(ilike(observation.localName, `%${input.local_name.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`));
  if (input.mapping_status === 'mapped') conditions.push(isNotNull(observation.conceptCode));
  if (input.mapping_status === 'unmapped') conditions.push(isNull(observation.conceptCode));
  if (input.from) conditions.push(gte(observation.observedOn, input.from));
  if (input.to) conditions.push(lte(observation.observedOn, input.to));
  if (input.source) conditions.push(eq(observation.source, input.source));
  if (input.review_status) conditions.push(eq(observation.reviewStatus, input.review_status));
  if (input.document_id) conditions.push(eq(observation.documentId, input.document_id));
  if (input.cursor) {
    const decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as {
      observed_on?: string; observed_at?: string | null; id?: string;
    };
    if (!decoded.observed_on || !decoded.id) throw new ApiError('validation_failed', '游标无效');
    const cursorTime = decoded.observed_at ? new Date(decoded.observed_at) : null;
    conditions.push(or(
      lt(observation.observedOn, decoded.observed_on),
      and(eq(observation.observedOn, decoded.observed_on), cursorTime
        ? or(isNull(observation.observedAt), lt(observation.observedAt, cursorTime))
        : and(isNull(observation.observedAt), lt(observation.id, decoded.id))),
      and(eq(observation.observedOn, decoded.observed_on),
        cursorTime ? eq(observation.observedAt, cursorTime) : isNull(observation.observedAt),
        lt(observation.id, decoded.id)),
    )!);
  }
  const rows = await db.select().from(observation).where(and(...conditions))
    .orderBy(desc(observation.observedOn), desc(observation.observedAt), desc(observation.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    observations: page.map(observationOut),
    next_cursor: rows.length > input.limit && last ? Buffer.from(JSON.stringify({
      observed_on: last.observedOn, observed_at: last.observedAt?.toISOString() ?? null, id: last.id,
    })).toString('base64url') : null,
  };
}

function patchRowFromCurrent(current: ObservationRow, body: ObservationPatchRequestT): ObservationBatchRowT {
  const rawChanged = has(body, 'value_raw');
  const unitRawChanged = has(body, 'unit_raw');
  const pick = <T>(key: keyof ObservationPatchRequestT, fallback: T): T =>
    (has(body, key as string) ? body[key] : fallback) as T;
  return {
    client_row_id: current.clientRowId ?? current.id,
    document_id: pick('document_id', current.documentId), encounter_id: pick('encounter_id', current.encounterId),
    observed_on: pick('observed_on', current.observedOn),
    observed_at: pick('observed_at', current.observedAt?.toISOString() ?? null),
    time_precision: pick('time_precision', current.timePrecision) as any,
    date_source: pick('date_source', current.dateSource) as any,
    local_name: pick('local_name', current.localName),
    concept_code: pick('concept_code', current.conceptCode),
    concept_catalog_version: pick('concept_catalog_version', current.conceptCatalogVersion),
    loinc_code: current.loincCode, qualifier: pick('qualifier', current.qualifier),
    body_site: pick('body_site', current.bodySite), extra_dims: pick('extra_dims', current.extraDims as any),
    value_raw: pick('value_raw', current.valueRaw),
    value_num: pick('value_num', rawChanged ? null : current.valueNum),
    comparator: pick('comparator', rawChanged ? null : current.comparator as any),
    value_text: pick('value_text', rawChanged ? null : current.valueText),
    value_dimensions: pick('value_dimensions', current.valueDimensions as any),
    unit_raw: pick('unit_raw', current.unitRaw),
    unit_ucum: pick('unit_ucum', unitRawChanged ? null : current.unitUcum),
    ref_low: pick('ref_low', current.refLow), ref_high: pick('ref_high', current.refHigh),
    ref_text: pick('ref_text', current.refText), ref_unit: pick('ref_unit', current.refUnit),
    abnormal_flag_raw: pick('abnormal_flag_raw', current.abnormalFlagRaw),
    abnormal_flag: pick('abnormal_flag', current.abnormalFlag as any),
    specimen: pick('specimen', current.specimen), specimen_label: pick('specimen_label', current.specimenLabel),
    method: pick('method', current.method), device: pick('device', current.device),
    measurement_setting: pick('measurement_setting', current.measurementSetting),
    result_kind: pick('result_kind', current.resultKind) as any,
    collected_at: pick('collected_at', current.collectedAt?.toISOString() ?? null),
    reported_at: pick('reported_at', current.reportedAt?.toISOString() ?? null),
    lab_facility_id: pick('lab_facility_id', current.labFacilityId),
    source_page: has(body, 'source_page') ? body.source_page ?? null : stableOriginPage(current),
  };
}

async function mutateObservation(input: {
  observationId: string; accountId: string; body: ObservationPatchRequestT | ObservationArchiveRequestT;
  archive: boolean;
}) {
  return db.transaction(async (tx) => {
    const current = (await tx.select().from(observation)
      .where(eq(observation.id, input.observationId)).limit(1).for('update'))[0];
    if (!current) throw notFound();
    if (current.isDerived) {
      throw new ApiError('validation_failed', '派生 observation 由输入事实确定性生成，不可直接修改或归档');
    }
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, current.personId)).limit(1))[0];
    if (!owner) throw notFound();
    const request = { observation_id: input.observationId, archive: input.archive, ...input.body };
    const replay = await replayOperation<ObservationT>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return Observation.parse(replay.result);
    if (input.body.if_revision !== current.revision) {
      throw new ApiError('revision_conflict', 'observation 已被其他操作更新', {
        base_revision: input.body.if_revision, current: observationOut(current), draft: input.body,
      });
    }
    let row: ObservationRow;
    let conceptReference = current.conceptCode ? medicalConceptOut(current.conceptCode) : null;
    if (input.archive) {
      row = (await tx.update(observation).set({
        archivedAt: new Date(serverTimestamp()), revision: current.revision + 1,
        reviewStatus: 'corrected', reviewedBy: input.accountId, reviewedAt: new Date(),
        updatedBy: input.accountId, updatedAt: new Date(),
      }).where(eq(observation.id, current.id)).returning())[0]!;
    } else {
      const patch = input.body as ObservationPatchRequestT;
      const normalized = await normalizeFact(tx, {
        personId: current.personId, accountId: input.accountId,
        row: patchRowFromCurrent(current, patch), defaults: ObservationBatchDefaults.parse({}),
        path: ['draft'], existing: current,
      });
      const { warnings: _warnings, conceptReference: nextConcept, ...values } = normalized;
      conceptReference = nextConcept;
      row = (await tx.update(observation).set({ ...values, updatedAt: new Date() })
        .where(eq(observation.id, current.id)).returning())[0]!;
    }
    const before = observationOut(current);
    const response = observationOut(row);
    await projectObservationSearch(tx, response, replay.requestHash);
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'observation_upsert', subjectType: 'observation', subjectId: response.id,
      personId: response.person_id, requestHash: replay.requestHash, request, result: response,
    });
    const facilities = await facilitySnapshots(tx, [response.lab_facility_id]);
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'observation_upsert', event_id: input.body.client_operation_id,
      at: serverTimestamp(), by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: owner.slug,
      subject_id: response.id, revision: response.revision, before: [before], after: [response],
      correction_note: input.body.correction_note,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response },
      references: { concepts: conceptReference ? [conceptReference] : [], facilities, suggestion: null },
    });
    await rebuildDerivedObservations(tx, response.person_id);
    return response;
  });
}

export const patchObservation = (input: {
  observationId: string; accountId: string; body: ObservationPatchRequestT;
}) => mutateObservation({ ...input, archive: false });

export const archiveObservation = (input: {
  observationId: string; accountId: string; body: ObservationArchiveRequestT;
}) => mutateObservation({ ...input, archive: true });

export async function observationPersonId(observationId: string): Promise<string> {
  const row = (await db.select({ personId: observation.personId }).from(observation)
    .where(eq(observation.id, observationId)).limit(1))[0];
  if (!row) throw notFound();
  return row.personId;
}
