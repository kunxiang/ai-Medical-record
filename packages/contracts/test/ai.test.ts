// m2-99 B9:Stage 1 的每一层对象都必须 strict，未知键不能静默落入工件。
import { describe, expect, it } from 'vitest';
import { S1Artifact, Stage1Out } from '../src/ai.js';

const baseOutput = {
  doc_type: 'lab_report' as const,
  doc_type_confidence: 0.9,
  patient_name: 'P1',
  patient_sex: 'female' as const,
  patient_age_text: null,
  patient_identifiers: [{ type: 'record_no', value: 'synthetic' }],
  facility_name_raw: 'F1',
  department_raw: null,
  sampled_on: '2026-08-20',
  reported_on: null,
  event_at: null,
  summary: '合成验收摘要',
  pages: [{ page_no: 1, page_label: null, page_index: null, page_total: null, full_text: 'synthetic' }],
  pii_spans: [{ page_no: 1, kind: 'phone' as const, start: 0, end: 1 }],
  boundary_hint: { likely_same_document: true, reason: 'synthetic' },
  unmodeled: [{ label: 'x', value: 'y', page_no: 1 }],
};

describe('Stage 1 strict schemas', () => {
  it.each([
    ['root', { ...baseOutput, unknown: true }],
    ['patient identifier', { ...baseOutput, patient_identifiers: [{ ...baseOutput.patient_identifiers[0], unknown: true }] }],
    ['page', { ...baseOutput, pages: [{ ...baseOutput.pages[0], unknown: true }] }],
    ['pii span', { ...baseOutput, pii_spans: [{ ...baseOutput.pii_spans[0], unknown: true }] }],
    ['boundary hint', { ...baseOutput, boundary_hint: { ...baseOutput.boundary_hint, unknown: true } }],
    ['unmodeled', { ...baseOutput, unmodeled: [{ ...baseOutput.unmodeled[0], unknown: true }] }],
  ])('拒绝 %s 未知键', (_label, value) => {
    expect(Stage1Out.safeParse(value).success).toBe(false);
  });

  it('拒绝 artifact/usage 未知键', () => {
    const artifact = {
      schema_version: '1.0', stage: 's1', document_short_id: 'd23456',
      produced_at: '2026-08-27T00:00:00.000Z', model: 'synthetic-model',
      prompt_id: 's1-classify', prompt_version: 2, prompt_sha256: 'a'.repeat(64),
      effort: 'medium', batches: 1,
      usage: {
        input_tokens: 1, output_tokens: 1,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        unknown: true,
      },
      output: baseOutput,
    };
    expect(S1Artifact.safeParse(artifact).success).toBe(false);
    expect(S1Artifact.safeParse({ ...artifact, usage: { ...artifact.usage, unknown: undefined }, unknown: true }).success).toBe(false);
  });
});
