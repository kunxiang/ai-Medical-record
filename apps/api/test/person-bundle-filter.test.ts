import { describe, expect, it } from 'vitest';
import { filterDecisionForPerson } from '../src/exports/bundle-filter.js';

const base = {
  schema_version: '1.0' as const,
  op: 'normalization_confirm' as const,
  event_id: '018f47d2-4454-7d4b-8ad0-4cb96ad11a11',
  at: '2026-08-28T00:00:00.000Z',
  by_account_id: '018f47d2-4454-7d4b-8ad0-4cb96ad11a12',
  client_operation_id: '018f47d2-4454-7d4b-8ad0-4cb96ad11a13',
  input_fingerprint: 'a'.repeat(64),
  decision: 'confirmed' as const,
};

describe('P0 person bundle decision isolation', () => {
  it('facility decision 只保留目标 person 实际出现的原文', () => {
    const filtered = filterDecisionForPerson({
      ...base,
      kind: 'facility',
      payload: {
        facility: { slug: 'f23456', name: '示例医院', city: null, level: null },
        matched_raw_names: ['目标医院原文', '其他成员隐私原文'], confidence: 0.9, reason: '人工确认',
      },
    }, '018f47d2-4454-7d4b-8ad0-4cb96ad11a14', new Set(['目标医院原文']));
    expect(filtered?.payload).toMatchObject({ matched_raw_names: ['目标医院原文'] });
    expect(JSON.stringify(filtered)).not.toContain('其他成员隐私原文');
  });

  it('与目标 person 无关的 facility decision 被排除', () => {
    expect(filterDecisionForPerson({
      ...base,
      kind: 'facility',
      payload: {
        facility: { slug: 'f23456', name: '示例医院', city: null, level: null },
        matched_raw_names: ['其他成员隐私原文'], confidence: 0.9, reason: '人工确认',
      },
    }, '018f47d2-4454-7d4b-8ad0-4cb96ad11a14', new Set(['目标医院原文']))).toBeNull();
  });
});
