import { describe, expect, it } from 'vitest';
import {
  MetricGroupCreateRequest, MetricGroupPatchRequest, MetricSeriesSelector, TrendResponse,
} from '../src/index.js';

const OP = '018f7a6b-4c5d-7e8f-9012-3456789abcde';
const selector = {
  concept_code: 'GLUCOSE', qualifier: null, body_site: null, specimen: 'serum',
  method: null, device: null, measurement_setting: null, extra_dims: null,
  result_kind: 'measured' as const,
};

describe('P3 metric group and trend contracts', () => {
  it('requires a complete series identity', () => {
    expect(MetricSeriesSelector.safeParse(selector).success).toBe(true);
    const { specimen: _specimen, ...incomplete } = selector;
    expect(MetricSeriesSelector.safeParse(incomplete).success).toBe(false);
  });

  it('copies either a preset or custom items, never both', () => {
    expect(MetricGroupCreateRequest.safeParse({
      client_operation_id: OP, name: '三高+', preset: 'three_high_plus',
    }).success).toBe(true);
    expect(MetricGroupCreateRequest.safeParse({
      client_operation_id: OP, name: '血糖', items: [{ selector }],
    }).success).toBe(true);
    expect(MetricGroupCreateRequest.safeParse({
      client_operation_id: OP, name: '错误', preset: 'three_high_plus', items: [{ selector }],
    }).success).toBe(false);
  });

  it('rejects duplicate selectors and empty patches', () => {
    expect(MetricGroupCreateRequest.safeParse({
      client_operation_id: OP, name: '重复', items: [{ selector }, { selector }],
    }).success).toBe(false);
    expect(MetricGroupPatchRequest.safeParse({
      client_operation_id: OP, if_revision: 1,
    }).success).toBe(false);
  });

  it('expresses honest empty trend state without fabricated points', () => {
    const now = '2026-08-28T00:00:00.000Z';
    expect(TrendResponse.safeParse({
      group: {
        id: OP, person_id: OP, name: '血糖', description: null, preset_origin: null,
        items: [{
          id: OP, position: 0, item_type: 'series', selector,
          series_selector_hash: 'a'.repeat(64),
        }],
        revision: 1, created_by: OP, created_at: now, updated_by: OP,
        updated_at: now, archived_at: null,
      },
      state: 'empty', total_points: 0, returned_points: 0, downsampled: false,
      downsample_version: null, next_cursor: null, series: [{
        group_item_id: OP, position: 0, selector,
        series_selector_hash: 'a'.repeat(64), lines: [],
      }], overlays: [],
    }).success).toBe(true);
  });
});
