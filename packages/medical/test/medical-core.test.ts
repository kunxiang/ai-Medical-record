import { describe, expect, it } from 'vitest';
import {
  CONCEPT_CATALOG_VERSION, bodyMassIndex, canonicalSeriesIdentity, canonicalUcum,
  conceptByCode, convertToCanonical, convertToSi, convertUreaBun, egfrCkdEpi2021,
  deriveObservationPlans, exceedsRcv, nonHdlCholesterol,
  observationConsistencyFlags, parseResultValue, referenceChangeValue, searchConcepts,
} from '../src/index.js';

describe('P2 deterministic medical core', () => {
  it('searches the versioned catalog without normal ranges', () => {
    expect(CONCEPT_CATALOG_VERSION).toBe('2026.08');
    expect(searchConcepts('低密度')[0]?.code).toBe('LDL_C');
    expect(searchConcepts('tg')[0]?.code).toBe('TRIGLYCERIDES');
    expect(conceptByCode('glucose')?.canonical_unit).toBe('mmol/L');
  });

  it('parses comparator/numeric values and preserves unknown text', () => {
    expect(parseResultValue('<3.62')).toEqual({
      kind: 'numeric', raw: '<3.62', comparator: '<', value: 3.62, text: null,
    });
    expect(parseResultValue('≤ 1.2')).toMatchObject({ comparator: '<=', value: 1.2 });
    expect(parseResultValue('阴性')).toEqual({
      kind: 'text', raw: '阴性', comparator: null, value: null, text: '阴性',
    });
  });

  it('normalizes explicit UCUM spellings and never guesses unknown units', () => {
    expect(canonicalUcum('μmol/L')).toBe('umol/L');
    expect(canonicalUcum('mystery')).toBeNull();
    expect(convertToCanonical('GLUCOSE', 180.16, 'mg/dL')).toEqual({
      value: 10, unit: 'mmol/L', version: 'medical-units@1',
    });
    expect(convertToCanonical('TRIGLYCERIDES', 88.57, 'mg/dL')?.value).toBe(1);
    expect(convertToCanonical('LDL_C', 38.67, 'mg/dL')?.value).toBe(1);
    expect(convertToCanonical('GLUCOSE', 1, 'mystery')).toBeNull();
    expect(convertToSi('HBA1C', 53, 'mmol/mol')).toEqual({
      value: 7.00044, unit: '%', version: 'medical-units@1',
    });
  });

  it('converts urea/BUN only through an explicit concept change', () => {
    expect(convertToCanonical('UREA', 14, 'mg/dL')).toBeNull();
    expect(convertUreaBun('UREA', 5, 'mmol/L', 'BUN')).toEqual({
      concept_code: 'BUN', value: 14, unit: 'mg/dL', version: 'medical-units@1',
    });
    expect(convertUreaBun('BUN', 14, 'mg/dL', 'UREA')).toEqual({
      concept_code: 'UREA', value: 5, unit: 'mmol/L', version: 'medical-units@1',
    });
  });

  it('keeps every series dimension in a canonical identity', () => {
    const base = {
      concept_code: 'BP_SYSTOLIC', qualifier: null, body_site: 'left_arm', specimen: null,
      method: null, device: null, measurement_setting: 'home', extra_dims: null,
      result_kind: 'measured' as const,
    };
    expect(canonicalSeriesIdentity(base)).not.toBe(canonicalSeriesIdentity({ ...base, measurement_setting: 'office' }));
  });

  it('returns neutral consistency flags instead of medical conclusions', () => {
    expect(observationConsistencyFlags({
      value_raw: '<3.62', value_num: 3.7, unit_raw: null, ref_low: 5, ref_high: 3,
    })).toEqual(['reference_bounds_reversed', 'numeric_unit_missing', 'numeric_raw_mismatch']);
  });

  it('derives only when required inputs are valid and records versions', () => {
    expect(egfrCkdEpi2021({ creatinineMgDl: 1, ageYears: 17, sexAtBirth: 'male' })).toBeNull();
    expect(egfrCkdEpi2021({ creatinineMgDl: 1, ageYears: 40, sexAtBirth: 'female' })?.version)
      .toBe('ckd-epi-2021@1');
    expect(nonHdlCholesterol(5, 1.2)).toEqual({ value: 3.8, version: 'non-hdl@1' });
    expect(bodyMassIndex(70, 1.75)).toEqual({ value: 22.86, version: 'bmi@1' });
  });

  it('builds stable dependency plans and changes only the input revision hash on correction', () => {
    const fact = (id: string, conceptCode: string, value: number, unit: string) => ({
      id, revision: 1, document_id: 'doc-1', encounter_id: null,
      observed_on: '2026-08-28', observed_at: null, time_precision: 'date' as const,
      date_source: 'manual' as const, concept_code: conceptCode,
      value_num: value, value_si: value, unit_ucum: unit, unit_si: unit,
      qualifier: null, body_site: null, specimen: 'serum', specimen_label: '血清',
      method: null, device: null, measurement_setting: null, extra_dims: null,
      result_kind: 'measured' as const, collected_at: null, reported_at: null,
      lab_facility_id: null,
    });
    const facts = [
      fact('creatinine', 'CREATININE', 88.4, 'umol/L'),
      fact('total', 'TOTAL_CHOLESTEROL', 5, 'mmol/L'),
      fact('hdl', 'HDL_C', 1.2, 'mmol/L'),
      fact('weight', 'WEIGHT', 70, 'kg'),
      fact('height', 'HEIGHT', 175, 'cm'),
    ];
    const first = deriveObservationPlans({
      person: { birth_date: '1986-01-01', sex_at_birth: 'female' }, facts,
    });
    expect(first.map((item) => item.concept_code).sort()).toEqual(['BMI', 'EGFR_CKD_EPI_2021', 'NON_HDL_C']);
    expect(first.find((item) => item.concept_code === 'NON_HDL_C')?.value).toBe(3.8);
    const corrected = deriveObservationPlans({
      person: { birth_date: '1986-01-01', sex_at_birth: 'female' },
      facts: facts.map((item) => item.id === 'total' ? { ...item, revision: 2, value_num: 4.8, value_si: 4.8 } : item),
    });
    const before = first.find((item) => item.concept_code === 'NON_HDL_C')!;
    const after = corrected.find((item) => item.concept_code === 'NON_HDL_C')!;
    expect(after.id).toBe(before.id);
    expect(after.derivation_key).toBe(before.derivation_key);
    expect(after.input_revision_hash).not.toBe(before.input_revision_hash);
    expect(after.value).toBe(3.6);
  });

  it('computes versioned RCV and returns null for unsupported concepts', () => {
    expect(referenceChangeValue('LDL_C')?.rcvPercent).toBeGreaterThan(20);
    expect(exceedsRcv('LDL_C', 3.2, 3.5)).toBe(false);
    expect(referenceChangeValue('UNKNOWN')).toBeNull();
  });
});
