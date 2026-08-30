import { createHash } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  CONCEPT_CATALOG_VERSION, conceptByCode, deriveObservationPlans,
  type DerivationInputFact,
} from '@amr/medical';
import { canonicalJson, serverTimestamp } from '@amr/storage';
import { type Tx } from '../db/client.js';
import { observation, person, searchEntry } from '../db/schema.js';
import { notFound } from '../errors.js';

function mappingFingerprint(localName: string, specimen: string | null, method: string | null): string {
  return createHash('sha256').update(canonicalJson({
    local_name: localName.normalize('NFKC').trim().toLocaleLowerCase('zh-CN'), specimen, method,
  })).digest('hex');
}

/** 可删除 L2 投影：每次 L1 Observation 改变后整个 person 确定性重算。 */
export async function rebuildDerivedObservations(tx: Tx, personId: string): Promise<number> {
  const profile = (await tx.select({
    birthDate: person.birthDate, sexAtBirth: person.sexAtBirth,
  }).from(person).where(eq(person.id, personId)).limit(1))[0];
  if (!profile) throw notFound();
  const rows = await tx.select().from(observation).where(and(
    eq(observation.personId, personId), eq(observation.isDerived, false),
    isNull(observation.archivedAt), isNotNull(observation.conceptCode),
  ));
  const facts: DerivationInputFact[] = rows.map((row) => ({
    id: row.id, revision: row.revision, document_id: row.documentId,
    encounter_id: row.encounterId, observed_on: row.observedOn,
    observed_at: row.observedAt?.toISOString() ?? null,
    time_precision: row.timePrecision as DerivationInputFact['time_precision'],
    date_source: row.dateSource as DerivationInputFact['date_source'],
    concept_code: row.conceptCode!, value_num: row.valueNum, value_si: row.valueSi,
    unit_ucum: row.unitUcum, unit_si: row.unitSi, qualifier: row.qualifier,
    body_site: row.bodySite, specimen: row.specimen, specimen_label: row.specimenLabel,
    method: row.method, device: row.device, measurement_setting: row.measurementSetting,
    extra_dims: row.extraDims as Record<string, string> | null,
    result_kind: row.resultKind as DerivationInputFact['result_kind'],
    collected_at: row.collectedAt?.toISOString() ?? null,
    reported_at: row.reportedAt?.toISOString() ?? null, lab_facility_id: row.labFacilityId,
  }));
  const plans = deriveObservationPlans({
    person: {
      birth_date: profile.birthDate,
      sex_at_birth: profile.sexAtBirth as 'male' | 'female' | 'unknown',
    },
    facts,
  });

  const old = await tx.select({ id: observation.id }).from(observation).where(and(
    eq(observation.personId, personId), eq(observation.isDerived, true),
  ));
  if (old.length > 0) {
    await tx.delete(searchEntry).where(and(
      eq(searchEntry.entityType, 'observation'),
      inArray(searchEntry.entityId, old.map((row) => row.id)),
    ));
  }
  await tx.delete(observation).where(and(
    eq(observation.personId, personId), eq(observation.isDerived, true),
  ));

  const now = new Date(serverTimestamp());
  for (const item of plans) {
    const concept = conceptByCode(item.concept_code)!;
    const basis = item.basis;
    await tx.insert(observation).values({
      id: item.id, personId, documentId: basis.document_id, encounterId: basis.encounter_id,
      clientRowId: null, observedOn: basis.observed_on,
      observedAt: basis.observed_at ? new Date(basis.observed_at) : null,
      timePrecision: basis.time_precision, dateSource: basis.date_source,
      localName: item.local_name,
      mappingFingerprint: mappingFingerprint(item.local_name, basis.specimen, basis.method),
      conceptCode: item.concept_code, conceptCatalogVersion: CONCEPT_CATALOG_VERSION,
      loincCode: concept.loinc_code, qualifier: basis.qualifier, bodySite: basis.body_site,
      extraDims: basis.extra_dims, seriesKey: item.series_key,
      valueRaw: String(item.value), valueNum: item.value, comparator: '=', valueText: null,
      valueDimensions: null, unitRaw: item.unit, unitUcum: item.unit,
      valueSi: item.value, unitSi: item.unit, conversionVersion: 'derived-canonical@1',
      refLow: null, refHigh: null, refText: null, refUnit: null,
      abnormalFlagRaw: null, abnormalFlag: null, specimen: basis.specimen,
      specimenLabel: basis.specimen_label, method: basis.method, device: basis.device,
      measurementSetting: basis.measurement_setting, resultKind: 'calculated',
      collectedAt: basis.collected_at ? new Date(basis.collected_at) : null,
      reportedAt: basis.reported_at ? new Date(basis.reported_at) : null,
      labFacilityId: basis.lab_facility_id,
      originCaptureDocumentId: null, originCaptureOrder: null, objectSha256: null,
      logicalPageIndex: null, sourceBbox: null, currentDocumentId: null, currentPageNo: null,
      source: 'derived', sourceRef: null, reviewStatus: 'confirmed', reviewedBy: null,
      reviewedAt: now, consistencyFlags: [], isDerived: true,
      derivedFormula: item.formula, calculationVersion: item.calculation_version,
      derivationKey: item.derivation_key, inputObservationIds: item.input_observation_ids,
      inputRevisionHash: item.input_revision_hash, revision: 1,
      createdBy: null, createdAt: now, updatedBy: null, updatedAt: now, archivedAt: null,
    });
    const body = [item.concept_code, item.value, item.unit, item.formula].join('\n');
    await tx.insert(searchEntry).values({
      id: item.id, personId, entityType: 'observation', entityId: item.id,
      documentId: basis.document_id, occurredOn: basis.observed_on,
      sortAt: basis.observed_at ? new Date(basis.observed_at)
        : new Date(`${basis.observed_on}T00:00:00.000Z`),
      title: item.local_name, coreBody: body, sourceRevisionHash: item.input_revision_hash,
    });
  }
  return plans.length;
}
