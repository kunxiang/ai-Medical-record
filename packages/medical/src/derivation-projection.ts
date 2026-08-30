import { createHash } from 'node:crypto';
import { canonicalJsonString } from '@amr/contracts';
import { conceptByCode } from './concepts.js';
import {
  DERIVATION_VERSIONS, bodyMassIndex, egfrCkdEpi2021, nonHdlCholesterol,
} from './derivations.js';
import { canonicalSeriesIdentity } from './series.js';

export interface DerivationPersonProfile {
  birth_date: string | null;
  sex_at_birth: 'male' | 'female' | 'unknown';
}

export interface DerivationInputFact {
  id: string;
  revision: number;
  document_id: string | null;
  encounter_id: string | null;
  observed_on: string;
  observed_at: string | null;
  time_precision: 'date' | 'minute' | 'unknown';
  date_source: 'manual' | 'document_sampled' | 'document_reported';
  concept_code: string;
  value_num: number | null;
  value_si: number | null;
  unit_ucum: string | null;
  unit_si: string | null;
  qualifier: string | null;
  body_site: string | null;
  specimen: string | null;
  specimen_label: string | null;
  method: string | null;
  device: string | null;
  measurement_setting: string | null;
  extra_dims: Record<string, string> | null;
  result_kind: 'measured' | 'calculated' | 'input_parameter';
  collected_at: string | null;
  reported_at: string | null;
  lab_facility_id: string | null;
}

export interface DerivedObservationPlan {
  id: string;
  derivation_key: string;
  input_observation_ids: string[];
  input_revision_hash: string;
  concept_code: 'EGFR_CKD_EPI_2021' | 'NON_HDL_C' | 'BMI';
  local_name: string;
  value: number;
  unit: string;
  formula: string;
  calculation_version: string;
  series_key: string;
  basis: DerivationInputFact;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJsonString(value)).digest('hex');
}

function uuidFromHash(value: string): string {
  const hex = value.slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function ageOn(birthDate: string, observedOn: string): number {
  const [birthYear, birthMonth, birthDay] = birthDate.split('-').map(Number);
  const [year, month, day] = observedOn.split('-').map(Number);
  let age = year! - birthYear!;
  if (month! < birthMonth! || (month === birthMonth && day! < birthDay!)) age -= 1;
  return age;
}

function comparableValue(fact: DerivationInputFact, unit: string): number | null {
  if (fact.value_si !== null && fact.unit_si === unit) return fact.value_si;
  if (fact.value_num !== null && fact.unit_ucum === unit) return fact.value_num;
  return null;
}

function contextKey(fact: DerivationInputFact): string {
  return canonicalJsonString({
    document_id: fact.document_id, encounter_id: fact.encounter_id,
    observed_on: fact.observed_on, observed_at: fact.observed_at,
    time_precision: fact.time_precision, qualifier: fact.qualifier, body_site: fact.body_site,
    specimen: fact.specimen, method: fact.method, device: fact.device,
    measurement_setting: fact.measurement_setting, extra_dims: fact.extra_dims,
  });
}

function plan(input: {
  conceptCode: DerivedObservationPlan['concept_code']; value: number; unit: string;
  formula: string; calculationVersion: string; inputs: DerivationInputFact[];
}): DerivedObservationPlan {
  const basis = input.inputs[0]!;
  const ids = input.inputs.map((fact) => fact.id);
  const derivationKey = hash({
    concept_code: input.conceptCode, formula: input.formula,
    calculation_version: input.calculationVersion, input_observation_ids: ids,
  });
  const inputRevisionHash = hash(input.inputs.map((fact) => ({
    id: fact.id, revision: fact.revision, value_num: fact.value_num,
    value_si: fact.value_si, unit_ucum: fact.unit_ucum, unit_si: fact.unit_si,
  })));
  const concept = conceptByCode(input.conceptCode)!;
  const seriesKey = hash(canonicalSeriesIdentity({
    concept_code: input.conceptCode, qualifier: basis.qualifier, body_site: basis.body_site,
    specimen: basis.specimen, method: basis.method, device: basis.device,
    measurement_setting: basis.measurement_setting, extra_dims: basis.extra_dims,
    result_kind: 'calculated',
  }));
  return {
    id: uuidFromHash(derivationKey), derivation_key: derivationKey,
    input_observation_ids: ids, input_revision_hash: inputRevisionHash,
    concept_code: input.conceptCode, local_name: concept.display_name,
    value: input.value, unit: input.unit, formula: input.formula,
    calculation_version: input.calculationVersion, series_key: seriesKey, basis,
  };
}

/**
 * 从已确认、未归档的 L1 事实生成可删除 L2 派生计划。
 * 多输入公式只在同文档/就诊/时间/完整 series context 中各有唯一输入时计算，
 * 遇到重复值宁可返回空，不猜测配对。
 */
export function deriveObservationPlans(input: {
  person: DerivationPersonProfile;
  facts: DerivationInputFact[];
}): DerivedObservationPlan[] {
  const eligible = input.facts.filter((fact) => fact.result_kind !== 'input_parameter');
  const result: DerivedObservationPlan[] = [];

  for (const creatinine of eligible.filter((fact) => fact.concept_code === 'CREATININE')) {
    if (!input.person.birth_date) continue;
    const umol = comparableValue(creatinine, 'umol/L');
    if (umol === null) continue;
    const derived = egfrCkdEpi2021({
      creatinineMgDl: umol / 88.4,
      ageYears: ageOn(input.person.birth_date, creatinine.observed_on),
      sexAtBirth: input.person.sex_at_birth,
    });
    if (derived) result.push(plan({
      conceptCode: 'EGFR_CKD_EPI_2021', value: derived.value, unit: derived.unit,
      formula: 'CKD-EPI 2021 creatinine', calculationVersion: derived.version,
      inputs: [creatinine],
    }));
  }

  const groups = new Map<string, DerivationInputFact[]>();
  for (const fact of eligible) {
    const key = contextKey(fact);
    const rows = groups.get(key) ?? [];
    rows.push(fact);
    groups.set(key, rows);
  }
  for (const rows of groups.values()) {
    const total = rows.filter((fact) => fact.concept_code === 'TOTAL_CHOLESTEROL');
    const hdl = rows.filter((fact) => fact.concept_code === 'HDL_C');
    if (total.length === 1 && hdl.length === 1) {
      const totalValue = comparableValue(total[0]!, 'mmol/L');
      const hdlValue = comparableValue(hdl[0]!, 'mmol/L');
      const derived = totalValue === null || hdlValue === null
        ? null : nonHdlCholesterol(totalValue, hdlValue);
      if (derived) result.push(plan({
        conceptCode: 'NON_HDL_C', value: derived.value, unit: 'mmol/L',
        formula: 'total_cholesterol - hdl_c', calculationVersion: DERIVATION_VERSIONS.nonHdl,
        inputs: [total[0]!, hdl[0]!],
      }));
    }

    const weight = rows.filter((fact) => fact.concept_code === 'WEIGHT');
    const height = rows.filter((fact) => fact.concept_code === 'HEIGHT');
    if (weight.length === 1 && height.length === 1) {
      const weightKg = comparableValue(weight[0]!, 'kg');
      const heightCm = comparableValue(height[0]!, 'cm');
      const derived = weightKg === null || heightCm === null
        ? null : bodyMassIndex(weightKg, heightCm / 100);
      if (derived) result.push(plan({
        conceptCode: 'BMI', value: derived.value, unit: 'kg/m2',
        formula: 'weight_kg / height_m^2', calculationVersion: DERIVATION_VERSIONS.bmi,
        inputs: [weight[0]!, height[0]!],
      }));
    }
  }
  return result.sort((left, right) => left.derivation_key.localeCompare(right.derivation_key));
}
