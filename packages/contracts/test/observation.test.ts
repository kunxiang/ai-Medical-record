import { describe, expect, it } from 'vitest';
import {
  ObservationBatchCreateRequest, ObservationMappingResolveRequest,
  ObservationPatchRequest, ObservationSourceBbox, ObservationSuggestionAcceptRequest,
  ObservationSuggestionPayload,
} from '../src/index.js';

const op = '018f7a6b-4c5d-7e8f-9012-3456789abcde';
const row = '018f7a6b-4c5d-7e8f-9012-3456789abcdf';

describe('P2 observation contracts', () => {
  it('accepts a complete mapped row with report defaults', () => {
    const parsed = ObservationBatchCreateRequest.parse({
      client_operation_id: op,
      defaults: { observed_on: '2026-08-28', specimen: 'serum' },
      observations: [{
        client_row_id: row, local_name: '低密度脂蛋白胆固醇',
        concept_code: 'LDL_C', concept_catalog_version: '2026.08',
        value_raw: '<3.62', value_num: 3.62, comparator: '<', unit_raw: 'mmol/L',
        unit_ucum: 'mmol/L', ref_low: 0, ref_high: 3.37,
      }],
    });
    expect(parsed.observations[0]?.result_kind).toBe('measured');
    expect(parsed.defaults.time_precision).toBe('date');
  });

  it('accepts raw-only values for deterministic server parsing', () => {
    const parsed = ObservationBatchCreateRequest.parse({
      client_operation_id: op,
      defaults: { observed_on: '2026-08-28' },
      observations: [{
        client_row_id: row, local_name: '肌酐',
        concept_code: 'CREATININE', concept_catalog_version: '2026.08',
        value_raw: '<1.20', unit_raw: 'mg/dL',
      }],
    });
    expect(parsed.observations[0]?.value_num).toBeNull();
    expect(parsed.observations[0]?.comparator).toBeNull();
  });

  it('keeps an unknown concept/unit as an unmapped fact', () => {
    expect(ObservationBatchCreateRequest.safeParse({
      client_operation_id: op,
      defaults: { observed_on: '2026-08-28' },
      observations: [{
        client_row_id: row, local_name: '本院自定义项目', value_raw: '阴性',
        value_text: '阴性', unit_raw: '本院单位',
      }],
    }).success).toBe(true);
  });

  it('reports a row-scoped path and rejects the entire invalid batch', () => {
    const parsed = ObservationBatchCreateRequest.safeParse({
      client_operation_id: op,
      defaults: {},
      observations: [{ client_row_id: row, local_name: '血糖', value_raw: '5', value_num: 5 }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(['observations', 0, 'observed_on']);
  });

  it('does not invent midnight for date precision', () => {
    expect(ObservationBatchCreateRequest.safeParse({
      client_operation_id: op,
      defaults: { observed_on: '2026-08-28', observed_at: '2026-08-28T00:00:00Z' },
      observations: [{ client_row_id: row, local_name: '血糖', value_raw: '5', value_num: 5 }],
    }).success).toBe(false);
  });

  it('validates normalized source bbox bounds', () => {
    expect(ObservationSourceBbox.safeParse({ x: 0.8, y: 0.1, width: 0.3, height: 0.2 }).success).toBe(false);
    expect(ObservationSourceBbox.safeParse({ x: 0.1, y: 0.1, width: 0.3, height: 0.2 }).success).toBe(true);
  });

  it('requires a correction note and a real patch', () => {
    expect(ObservationPatchRequest.safeParse({
      client_operation_id: op, if_revision: 1, correction_note: '核对原件', value_num: 4.2,
    }).success).toBe(true);
    expect(ObservationPatchRequest.safeParse({
      client_operation_id: op, if_revision: 1, correction_note: '核对原件',
    }).success).toBe(false);
  });

  it('limits atomic mapping resolution to 100 rows', () => {
    const request = {
      client_operation_id: op, mode: 'selected', input_fingerprint: 'a'.repeat(64),
      local_name: '血糖', context: { specimen: null, method: null },
      concept_code: 'GLUCOSE', catalog_version: '2026.08',
      rows: Array.from({ length: 101 }, (_, index) => ({
        observation_id: `018f7a6b-4c5d-7e8f-9012-${String(index).padStart(12, '0')}`,
        if_revision: 1,
      })),
    };
    expect(ObservationMappingResolveRequest.safeParse(request).success).toBe(false);
  });

  it('keeps plugin suggestion rows separate from L1 client row ids', () => {
    const payload = ObservationSuggestionPayload.parse({
      defaults: { observed_on: '2026-08-28' },
      rows: [{
        row_id: 'row-1', draft: { local_name: '血糖', value_raw: '5.6', unit_raw: 'mmol/L' },
      }],
    });
    expect(payload.rows[0]?.draft).not.toHaveProperty('client_row_id');
    expect(ObservationSuggestionAcceptRequest.safeParse({
      client_operation_id: op, if_input_revision: 1,
      rows: [{ suggestion_row_id: 'row-1', client_row_id: row, overrides: { value_raw: '5.7' } }],
    }).success).toBe(true);
  });
});
