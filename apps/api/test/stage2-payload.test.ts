// m5-01:模型输出 → ObservationSuggestionPayload 的映射。
// 这是"能不能产出建议"的唯一转换点;它一旦不合契约,表现是静默没有建议。
import { beforeAll, describe, expect, it } from 'vitest';
import { ObservationSuggestionPayload } from '@amr/contracts';

let toPayload: typeof import('../src/jobs/stage2-handler.js')['stage2Internals']['toPayload'];
let fullTextOf: typeof import('../src/jobs/stage2-handler.js')['stage2Internals']['fullTextOf'];

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-auth-secret-that-is-at-least-32-bytes';
  ({ stage2Internals: { toPayload, fullTextOf } } = await import('../src/jobs/stage2-handler.js'));
});
const DOC = '01a064e0-01b3-768e-a620-3319f4535dd8';

const row = (over: Record<string, unknown> = {}) => ({
  local_name: '示例项目甲(AAA)', value_raw: '1.23',
  unit_raw: '10^9/L', ref_text: '1.00-2.00', abnormal_flag_raw: null,
  ...over,
});

describe('stage 2 建议映射', () => {
  it('产出的 payload 通过契约校验', () => {
    const payload = toPayload([row(), row({ local_name: '示例项目乙' })], {
      documentId: DOC, sampledOn: '2026-08-21',
    });
    expect(() => ObservationSuggestionPayload.parse(payload)).not.toThrow();
  });

  it('row_id 唯一且稳定 —— accepted_row_ids 靠它定位', () => {
    const payload = toPayload([row(), row(), row()], { documentId: DOC, sampledOn: null });
    const ids = payload.rows.map((r) => r.row_id);
    expect(ids).toEqual(['row-01', 'row-02', 'row-03']);
    expect(new Set(ids).size).toBe(3);
  });

  it('有采集日期时带上 document_sampled 来源', () => {
    const payload = toPayload([row()], { documentId: DOC, sampledOn: '2026-08-21' });
    expect(payload.defaults.observed_on).toBe('2026-08-21');
    expect(payload.defaults.date_source).toBe('document_sampled');
  });

  it('★ 没有采集日期时留空,不编一个 —— 编日期会把数据静默放到趋势的错误位置', () => {
    const payload = toPayload([row()], { documentId: DOC, sampledOn: null });
    expect(payload.defaults.observed_on).toBeUndefined();
    expect(payload.defaults.date_source).toBe('manual');
  });

  it('★ 归一字段一律留空,不让模型猜', () => {
    const draft = toPayload([row()], { documentId: DOC, sampledOn: null }).rows[0]!.draft;
    expect(draft.concept_code).toBeNull();
    expect(draft.unit_ucum).toBeNull();
    expect(draft.ref_low).toBeNull();
    expect(draft.ref_high).toBeNull();
    expect(draft.value_num).toBeNull();
    // 但原文必须原样带过去
    expect(draft.value_raw).toBe('1.23');
    expect(draft.unit_raw).toBe('10^9/L');
    expect(draft.ref_text).toBe('1.00-2.00');
  });

  it('defaults 带上 document_id,接受时才知道观测挂在哪份单据', () => {
    const payload = toPayload([row()], { documentId: DOC, sampledOn: null });
    expect(payload.defaults.document_id).toBe(DOC);
  });

  it('多页 full_text 按页顺序拼接,空页跳过', () => {
    const artifact = JSON.stringify({
      schema_version: '1.0', stage: 's1', document_short_id: 'dnzayq',
      produced_at: '2026-09-03T02:19:42.000Z', model: 'm', prompt_id: 's1-classify',
      prompt_version: 3, prompt_sha256: 'a'.repeat(64), effort: 'medium', batches: 1,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      output: {
        doc_type: 'lab_report', doc_type_confidence: 1, sampled_on: null, reported_on: null,
        event_at: null, facility_name_raw: null, department_raw: null, patient_name: null,
        patient_sex: null, patient_age_text: null, patient_identifiers: [], pii_spans: [],
        summary: '血常规', unmodeled: [], boundary_hint: { likely_same_document: true, reason: 'r' },
        pages: [
          { page_no: 1, page_label: null, page_index: null, page_total: null, full_text: '第一页' },
          { page_no: 2, page_label: null, page_index: null, page_total: null, full_text: '   ' },
          { page_no: 3, page_label: null, page_index: null, page_total: null, full_text: '第三页' },
        ],
      },
    });
    expect(fullTextOf(artifact)).toBe('第一页\n\n第三页');
  });
});
