import { describe, expect, it } from 'vitest';
import {
  MedicationBatchCreateRequest, TimelineEventCreateRequest, TimelineEventListQuery,
} from '../src/index.js';

const op = '018f05d8-4632-7b19-a891-55e09d42c123';
const row = '018f05d8-4632-7b19-a891-55e09d42c124';

describe('P4 clinical fact contracts', () => {
  it('requires the canonical time for each medication kind', () => {
    const base = {
      client_operation_id: op,
      medications: [{
        client_row_id: row, encounter_id: null, kind: 'administered', name_raw: '0.9% 氯化钠',
        generic_name: null, dose_raw: '500 mL', dose_value: 500, dose_unit: 'mL',
        concentration_pct: 0.9, solute_mass_g: 4.5, frequency_raw: null, route: '静脉滴注',
        administration_group: '组 1', group_volume_ml: 500, sequence: 1,
        administered_at: null, started_on: null, ended_on: null, source_page: null, note: null,
      }],
    };
    expect(MedicationBatchCreateRequest.safeParse(base).success).toBe(false);
    expect(MedicationBatchCreateRequest.parse({
      ...base,
      medications: [{ ...base.medications[0], administered_at: '2026-08-28T08:30:00.000Z' }],
    }).medications[0]?.kind).toBe('administered');

    expect(MedicationBatchCreateRequest.safeParse({
      ...base,
      medications: [{
        ...base.medications[0], kind: 'prescribed', concentration_pct: null,
        solute_mass_g: null, administration_group: null, group_volume_ml: null,
        sequence: null, administered_at: null,
      }],
    }).success).toBe(false);
  });

  it('models undated timeline facts without substituting a technical timestamp', () => {
    const undated = TimelineEventCreateRequest.parse({
      client_operation_id: op, encounter_id: null, kind: 'other', title: '日期待确认',
      occurred_on: null, occurred_at: null, time_precision: 'unknown', note: null,
      source_page: null,
    });
    expect(undated.occurred_on).toBeNull();
    expect(TimelineEventCreateRequest.safeParse({
      ...undated, occurred_on: '2026-08-28', time_precision: 'unknown',
    }).success).toBe(false);
    expect(TimelineEventCreateRequest.safeParse({
      ...undated, occurred_on: '2026-08-28', occurred_at: null, time_precision: 'minute',
    }).success).toBe(false);
  });

  it('parses include_undated=false honestly', () => {
    expect(TimelineEventListQuery.parse({ person_id: op, include_undated: 'false' }).include_undated)
      .toBe(false);
  });
});
