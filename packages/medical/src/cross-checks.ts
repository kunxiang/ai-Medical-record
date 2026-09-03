// spec m5-02:化验单的**跨行自洽校验**。
//
// 存在理由:化验单本身是冗余的 —— 百分比要加到 100、绝对值是 WBC 乘百分比、
// MCV/MCH/MCHC 是仪器从 RBC/HGB/HCT 算出来的。这意味着 OCR 读错一个数字,等式就崩。
//
// 这条冗余是**唯一可规模化的验证手段**:让人逐项核对几十个数字是做不到的,
// 点一次"接受"只是把责任转移给用户,并不产生验证。机器算得出的就不该要人算。
//
// 规格与容差来自 fixtures/001-pediatric-emergency/expected-checks.json,
// 那批规则已在 4 份真实单据上跑过 26 次零失败。
//
// **已知天花板:小幅误读抓不到。** 实测 6 种典型误读抓到 4 种;
// PLT 227→221(PCT 偏差 2.7% < 容差 5%)与 Lym% 30.8→30.3(求和 99.5,偏差 0.5% < 容差 2%)
// 会漏过。容差不能收紧 —— 仪器本身就有取整与舍入,收紧会把正确单据判成失败。
// 所以这是"抓大放小":能拦住毁掉趋势图的量级错误,拦不住末位小数。

export type CrossCheckStatus = 'passed' | 'failed' | 'skipped';

export interface CrossCheckResult {
  rule: string;
  status: CrossCheckStatus;
  /** 参与本规则的概念代码。它决定了哪些行被这条规则"覆盖" */
  concepts: readonly string[];
  computed: number | null;
  reported: number | null;
  deviationPct: number | null;
  tolerancePct: number;
  /** skipped 时说明缺了什么 */
  missing?: readonly string[];
}

export interface CrossCheckRow {
  conceptCode: string;
  valueNum: number;
}

interface RuleSpec {
  rule: string;
  tolerancePct: number;
  /** 全部必须存在,缺一即 skipped */
  needs: readonly string[];
  /** 返回 [算出的值, 报告上的值] */
  evaluate: (v: Readonly<Record<string, number>>) => readonly [number, number];
}

const DIFF_PCT = ['NEUT_PCT', 'LYMPH_PCT', 'MONO_PCT', 'EO_PCT', 'BASO_PCT'] as const;
const DIFF_ABS = ['NEUT_ABS', 'LYMPH_ABS', 'MONO_ABS', 'EO_ABS', 'BASO_ABS'] as const;

const RULES: readonly RuleSpec[] = [
  {
    rule: 'wbc_differential_sum', tolerancePct: 2, needs: DIFF_PCT,
    evaluate: (v) => [DIFF_PCT.reduce((sum, k) => sum + v[k]!, 0), 100],
  },
  {
    rule: 'wbc_absolute_sum', tolerancePct: 3, needs: [...DIFF_ABS, 'WBC'],
    evaluate: (v) => [DIFF_ABS.reduce((sum, k) => sum + v[k]!, 0), v['WBC']!],
  },
  // 五个分项各自一条:某一项读错时,只有它自己失败,不牵连整张单据
  ...DIFF_PCT.map((pctKey, index): RuleSpec => {
    const absKey = DIFF_ABS[index]!;
    return {
      rule: `wbc_absolute_consistency:${absKey}`, tolerancePct: 10,
      needs: ['WBC', pctKey, absKey],
      evaluate: (v) => [v['WBC']! * v[pctKey]! / 100, v[absKey]!],
    };
  }),
  {
    rule: 'rbc_indices:MCV', tolerancePct: 3, needs: ['HCT', 'RBC', 'MCV'],
    evaluate: (v) => [v['HCT']! / v['RBC']! * 10, v['MCV']!],
  },
  {
    rule: 'rbc_indices:MCH', tolerancePct: 3, needs: ['HEMOGLOBIN', 'RBC', 'MCH'],
    evaluate: (v) => [v['HEMOGLOBIN']! / v['RBC']!, v['MCH']!],
  },
  {
    rule: 'rbc_indices:MCHC', tolerancePct: 3, needs: ['HEMOGLOBIN', 'HCT', 'MCHC'],
    evaluate: (v) => [v['HEMOGLOBIN']! / v['HCT']! * 100, v['MCHC']!],
  },
  {
    rule: 'platelet_crit', tolerancePct: 5, needs: ['PLT', 'MPV', 'PCT_PLATELET'],
    evaluate: (v) => [v['PLT']! * v['MPV']! / 10_000, v['PCT_PLATELET']!],
  },
  // 以下三条不在 fixture 规格里,是仪器打印的派生比值,校验它们等于免费多覆盖三行
  {
    rule: 'nlr_identity', tolerancePct: 2, needs: ['NEUT_ABS', 'LYMPH_ABS', 'NLR'],
    evaluate: (v) => [v['NEUT_ABS']! / v['LYMPH_ABS']!, v['NLR']!],
  },
  {
    rule: 'plr_identity', tolerancePct: 2, needs: ['PLT', 'LYMPH_ABS', 'PLR'],
    evaluate: (v) => [v['PLT']! / v['LYMPH_ABS']!, v['PLR']!],
  },
  {
    rule: 'p_lcc_identity', tolerancePct: 5, needs: ['PLT', 'P_LCR', 'P_LCC'],
    evaluate: (v) => [v['PLT']! * v['P_LCR']! / 100, v['P_LCC']!],
  },
];

/** 同一概念出现多行(跨仪器)时不做校验 —— 无法确定拿哪一行,宁可判为不可验证。 */
function indexRows(rows: readonly CrossCheckRow[]): Record<string, number> {
  const seen = new Map<string, number>();
  const dup = new Set<string>();
  for (const row of rows) {
    if (!Number.isFinite(row.valueNum)) continue;
    if (seen.has(row.conceptCode)) dup.add(row.conceptCode);
    else seen.set(row.conceptCode, row.valueNum);
  }
  const out: Record<string, number> = {};
  for (const [code, value] of seen) if (!dup.has(code)) out[code] = value;
  return out;
}

export function crossCheckLabPanel(rows: readonly CrossCheckRow[]): CrossCheckResult[] {
  const v = indexRows(rows);
  return RULES.map((spec) => {
    const missing = spec.needs.filter((code) => v[code] === undefined);
    if (missing.length > 0) {
      return {
        rule: spec.rule, status: 'skipped' as const, concepts: spec.needs,
        computed: null, reported: null, deviationPct: null,
        tolerancePct: spec.tolerancePct, missing,
      };
    }
    const [computed, reported] = spec.evaluate(v);
    // 报告值为 0 时用绝对差判定,避免除零把正确结果判成失败
    const deviationPct = reported === 0
      ? (computed === 0 ? 0 : Number.POSITIVE_INFINITY)
      : Math.abs(computed - reported) / Math.abs(reported) * 100;
    return {
      rule: spec.rule,
      status: deviationPct <= spec.tolerancePct ? ('passed' as const) : ('failed' as const),
      concepts: spec.needs, computed, reported, deviationPct,
      tolerancePct: spec.tolerancePct,
    };
  });
}

export type RowVerdict =
  /** 至少被一条通过的规则覆盖,且没有被任何失败规则牵连 */
  | 'verified'
  /** 没有任何规则能覆盖它 —— 机器帮不上忙,只能靠人看 */
  | 'unverifiable'
  /** 参与了至少一条失败的规则 */
  | 'failed';

/**
 * 把规则结论落到每一行。**失败优先于通过**:一行只要卷进任何一条失败的等式,
 * 就必须交给人 —— 我们不知道错的是它还是等式里的另一个数。
 */
export function classifyRows(
  rows: readonly CrossCheckRow[],
  results: readonly CrossCheckResult[],
): Map<string, RowVerdict> {
  const passed = new Set<string>();
  const failed = new Set<string>();
  for (const result of results) {
    if (result.status === 'passed') for (const code of result.concepts) passed.add(code);
    if (result.status === 'failed') for (const code of result.concepts) failed.add(code);
  }
  const out = new Map<string, RowVerdict>();
  for (const row of rows) {
    out.set(row.conceptCode,
      failed.has(row.conceptCode) ? 'failed'
        : passed.has(row.conceptCode) ? 'verified'
          : 'unverifiable');
  }
  return out;
}
