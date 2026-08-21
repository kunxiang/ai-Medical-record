// spec m2-99 B12:合并规则单测。25 页分 2 批的合并结果必须与单批送 25 页的字段选取规则一致;
// page_no 冲突时必须失败(而不是悄悄丢一页)。
import { describe, expect, it } from 'vitest';
import type { Stage1OutT } from '@amr/contracts';
import { assertBatchPages, MergeError, mergeBatches, planBatches } from '../src/stage1-merge.js';

const page = (n: number, text = `第${n}页正文`) => ({
  page_no: n, page_label: `第 ${n} 页,共 25 页`, page_index: n, page_total: 25, full_text: text,
});

function out(over: Partial<Stage1OutT> & { pages: Stage1OutT['pages'] }): Stage1OutT {
  return {
    doc_type: 'lab_report', doc_type_confidence: 0.9,
    patient_name: null, patient_sex: null, patient_age_text: null, patient_identifiers: [],
    facility_name_raw: null, department_raw: null,
    sampled_on: null, reported_on: null, event_at: null,
    summary: '', pii_spans: [], unmodeled: [], boundary_hint: null,
    ...over,
  } as Stage1OutT;
}

describe('planBatches(m2-02 §3.4)', () => {
  it('≤20 页为单批', () => {
    expect(planBatches([3, 1, 2])).toEqual([[1, 2, 3]]);
    expect(planBatches(Array.from({ length: 20 }, (_, i) => i + 1))).toHaveLength(1);
  });
  it('25 页切为 20 + 5,且按 page_no 升序', () => {
    const b = planBatches(Array.from({ length: 25 }, (_, i) => 25 - i));
    expect(b).toHaveLength(2);
    expect(b[0]).toHaveLength(20);
    expect(b[0]![0]).toBe(1);
    expect(b[1]).toEqual([21, 22, 23, 24, 25]);
  });
  it('页号重复即拒', () => {
    expect(() => planBatches([1, 2, 2])).toThrow(MergeError);
  });
});

describe('assertBatchPages(审核 #003 A7)', () => {
  it('模型自行编号(返回批内序号)必须被抓住', () => {
    const got = out({ pages: [page(1), page(2)] });          // 模型把 21/22 编成了 1/2
    expect(() => assertBatchPages([21, 22], got)).toThrow(MergeError);
  });
  it('一致则通过', () => {
    expect(() => assertBatchPages([21, 22], out({ pages: [page(21), page(22)] }))).not.toThrow();
  });
});

describe('mergeBatches(m2-03 §5)', () => {
  const b1 = out({
    pages: Array.from({ length: 20 }, (_, i) => page(i + 1)),
    doc_type: 'lab_report', doc_type_confidence: 0.7,
    patient_name: null, facility_name_raw: '市一院', summary: '首批摘要',
    pii_spans: [{ page_no: 3, kind: 'phone', start: 0, end: 11 }],
  });
  const b2 = out({
    pages: Array.from({ length: 5 }, (_, i) => page(i + 21)),
    doc_type: 'imaging_report', doc_type_confidence: 0.95,
    patient_name: '张三', facility_name_raw: '市二院', summary: '次批摘要',
    sampled_on: '2024-03-15',
    unmodeled: [{ label: '备注', value: 'x', page_no: 22 }],
  });

  it('页拼接完整且有序', () => {
    const m = mergeBatches([b1, b2]);
    expect(m.pages).toHaveLength(25);
    expect(m.pages.map((p) => p.page_no)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('doc_type 取置信度最高者', () => {
    expect(mergeBatches([b1, b2]).doc_type).toBe('imaging_report');
  });

  it('置信度并列时取页序靠前的批次', () => {
    const tie = { ...b2, doc_type_confidence: 0.7 };
    expect(mergeBatches([b1, tie]).doc_type).toBe('lab_report');
  });

  it('标量字段取首个非 null(按页序)', () => {
    const m = mergeBatches([b1, b2]);
    expect(m.patient_name).toBe('张三');        // 首批为 null,取次批
    expect(m.facility_name_raw).toBe('市一院');  // 首批非 null,不被次批覆盖
    expect(m.sampled_on).toBe('2024-03-15');
    expect(m.summary).toBe('首批摘要');          // summary 恒取首批
  });

  it('pii_spans 与 unmodeled 归并且不去重', () => {
    const dup = { ...b2, pii_spans: [{ page_no: 22, kind: 'phone' as const, start: 0, end: 11 }] };
    const m = mergeBatches([b1, dup]);
    expect(m.pii_spans).toHaveLength(2);                  // 两批各一条,同类不去重
    expect(m.pii_spans.map((s) => s.page_no)).toEqual([3, 22]);  // 按 page_no 排序
    expect(m.unmodeled).toHaveLength(1);                  // dup 展开自 b2,保留其 unmodeled
  });

  it('★ page_no 冲突必须失败,不得悄悄丢页', () => {
    const overlap = out({ pages: [page(20), page(21)] });
    expect(() => mergeBatches([b1, overlap])).toThrow(MergeError);
  });

  it('单批走同一条合并路径(两条路径行为一致)', () => {
    const single = out({ pages: [page(1)], patient_name: '李四', summary: 'x' });
    expect(mergeBatches([single]).patient_name).toBe('李四');
  });

  it('空批次列表即拒', () => {
    expect(() => mergeBatches([])).toThrow(MergeError);
  });
});
