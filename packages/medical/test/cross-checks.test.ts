// 基准来自 fixtures/001-pediatric-emergency —— 该案例的自洽校验已人工核对过全部通过。
// 用真实数值而不是编造的数字:容差是否合理只有真实单据能证伪。
import { describe, expect, it } from 'vitest';
import { classifyRows, crossCheckLabPanel, type CrossCheckRow } from '../src/cross-checks.js';

/** fixtures/001 血常规 + CRP 的实测值 */
const CASE_001: CrossCheckRow[] = [
  { conceptCode: 'WBC', valueNum: 7.02 },
  { conceptCode: 'NEUT_PCT', valueNum: 70.3 },
  { conceptCode: 'LYMPH_PCT', valueNum: 22.4 },
  { conceptCode: 'MONO_PCT', valueNum: 6.1 },
  { conceptCode: 'EO_PCT', valueNum: 1.2 },
  { conceptCode: 'BASO_PCT', valueNum: 0.0 },
  { conceptCode: 'NEUT_ABS', valueNum: 4.94 },
  { conceptCode: 'LYMPH_ABS', valueNum: 1.57 },
  { conceptCode: 'MONO_ABS', valueNum: 0.43 },
  { conceptCode: 'EO_ABS', valueNum: 0.08 },
  { conceptCode: 'BASO_ABS', valueNum: 0.0 },
  { conceptCode: 'RBC', valueNum: 5.17 },
  { conceptCode: 'HEMOGLOBIN', valueNum: 130 },
  { conceptCode: 'HCT', valueNum: 38.1 },
  { conceptCode: 'MCV', valueNum: 73.7 },
  { conceptCode: 'MCH', valueNum: 25.2 },
  { conceptCode: 'MCHC', valueNum: 341 },
  { conceptCode: 'PLT', valueNum: 417 },
  { conceptCode: 'MPV', valueNum: 7.7 },
  { conceptCode: 'PCT_PLATELET', valueNum: 0.32 },
];

const byRule = (rows: CrossCheckRow[]) =>
  new Map(crossCheckLabPanel(rows).map((r) => [r.rule, r]));

describe('跨行自洽校验 · fixtures/001 基准', () => {
  it('该案例的全部可执行规则均通过 —— 与人工核对结论一致', () => {
    const results = crossCheckLabPanel(CASE_001);
    const failed = results.filter((r) => r.status === 'failed');
    expect(failed).toEqual([]);
    expect(results.filter((r) => r.status === 'passed').length).toBeGreaterThanOrEqual(10);
  });

  it('复算值与 case.md 记录的一致', () => {
    const r = byRule(CASE_001);
    expect(r.get('wbc_differential_sum')!.computed).toBeCloseTo(100.0, 1);
    expect(r.get('wbc_absolute_sum')!.computed).toBeCloseTo(7.02, 2);
    expect(r.get('rbc_indices:MCV')!.computed).toBeCloseTo(73.69, 1);
    expect(r.get('rbc_indices:MCH')!.computed).toBeCloseTo(25.15, 1);
    expect(r.get('rbc_indices:MCHC')!.computed).toBeCloseTo(341.2, 0);
    expect(r.get('platelet_crit')!.computed).toBeCloseTo(0.321, 2);
  });

  it('★ 缺输入的规则静默跳过,不报错 —— 血气单没有氯离子时 anion_gap 必须跳过', () => {
    const results = crossCheckLabPanel([{ conceptCode: 'WBC', valueNum: 7.02 }]);
    expect(results.every((r) => r.status !== 'failed')).toBe(true);
    const skipped = results.filter((r) => r.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]!.missing!.length).toBeGreaterThan(0);
  });

  it('空输入不抛错', () => {
    expect(() => crossCheckLabPanel([])).not.toThrow();
  });
});

describe('跨行自洽校验 · 抓 OCR 误读', () => {
  const mutate = (code: string, value: number) =>
    CASE_001.map((row) => (row.conceptCode === code ? { ...row, valueNum: value } : row));

  it.each([
    ['HEMOGLOBIN', 110, 'rbc_indices:MCH'],
    ['RBC', 5.77, 'rbc_indices:MCV'],
    ['NEUT_ABS', 9.94, 'wbc_absolute_sum'],
    ['MCHC', 841, 'rbc_indices:MCHC'],
  ])('%s 读错成 %s 时,%s 失败', (code, value, expectedRule) => {
    const r = byRule(mutate(code as string, value as number));
    expect(r.get(expectedRule as string)!.status).toBe('failed');
  });

  it('★ 小幅误读会漏过 —— 这是记录在案的天花板,不是遗漏', () => {
    // PLT 417→411:PCT 偏差约 1.4%,在 5% 容差内
    const r = byRule(mutate('PLT', 411));
    expect(r.get('platelet_crit')!.status).toBe('passed');
  });
});

describe('逐行结论', () => {
  it('通过的规则覆盖到的行判为 verified', () => {
    const verdicts = classifyRows(CASE_001, crossCheckLabPanel(CASE_001));
    for (const code of ['WBC', 'NEUT_PCT', 'MCV', 'MCHC', 'PCT_PLATELET']) {
      expect(verdicts.get(code)).toBe('verified');
    }
  });

  it('★ 没有任何规则覆盖的行判为 unverifiable —— 那才是该给人看的', () => {
    const rows = [...CASE_001, { conceptCode: 'CRP', valueNum: 47.9 }];
    expect(classifyRows(rows, crossCheckLabPanel(rows)).get('CRP')).toBe('unverifiable');
  });

  it('★ 失败优先于通过 —— 卷进任何失败等式的行都要交给人', () => {
    const rows = CASE_001.map((r) => (r.conceptCode === 'MCHC' ? { ...r, valueNum: 841 } : r));
    const verdicts = classifyRows(rows, crossCheckLabPanel(rows));
    expect(verdicts.get('MCHC')).toBe('failed');
    // HEMOGLOBIN 同时参与了通过的 MCH 与失败的 MCHC ⇒ 仍然判失败
    expect(verdicts.get('HEMOGLOBIN')).toBe('failed');
  });

  it('★ 同一概念出现多行(跨仪器)时不校验,判为 unverifiable', () => {
    const rows = [...CASE_001, { conceptCode: 'HEMOGLOBIN', valueNum: 126 }];
    expect(classifyRows(rows, crossCheckLabPanel(rows)).get('HEMOGLOBIN')).toBe('unverifiable');
  });
});
