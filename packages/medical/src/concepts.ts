export const CONCEPT_CATALOG_VERSION = '2026.08';

export type MedicalConceptKind = 'laboratory' | 'vital' | 'anthropometric' | 'derived';

export interface MedicalConcept {
  code: string;
  display_name: string;
  aliases: readonly string[];
  kind: MedicalConceptKind;
  loinc_code: string | null;
  canonical_unit: string;
}

const concept = (
  code: string,
  displayName: string,
  aliases: readonly string[],
  kind: MedicalConceptKind,
  canonicalUnit: string,
  loincCode: string | null = null,
): MedicalConcept => ({
  code, display_name: displayName, aliases, kind,
  loinc_code: loincCode, canonical_unit: canonicalUnit,
});

/** 静态公开目录只用于统一名称与量纲，不携带“正常值”或诊断阈值。 */
export const CONCEPT_CATALOG: readonly MedicalConcept[] = [
  concept('GLUCOSE', '葡萄糖', ['血糖', '空腹血糖', 'glucose', 'glu'], 'laboratory', 'mmol/L'),
  concept('HBA1C', '糖化血红蛋白', ['hba1c', '糖化', 'glycated hemoglobin'], 'laboratory', '%'),
  concept('TOTAL_CHOLESTEROL', '总胆固醇', ['总胆固醇', 'tc', 'cholesterol'], 'laboratory', 'mmol/L'),
  concept('LDL_C', '低密度脂蛋白胆固醇', ['低密度脂蛋白', 'ldl-c', 'ldlc', 'ldl'], 'laboratory', 'mmol/L'),
  concept('HDL_C', '高密度脂蛋白胆固醇', ['高密度脂蛋白', 'hdl-c', 'hdlc', 'hdl'], 'laboratory', 'mmol/L'),
  concept('TRIGLYCERIDES', '甘油三酯', ['甘油三脂', 'tg', 'triglyceride'], 'laboratory', 'mmol/L'),
  concept('NON_HDL_C', '非高密度脂蛋白胆固醇', ['non-hdl-c', '非hdl'], 'derived', 'mmol/L'),
  concept('CREATININE', '肌酐', ['血肌酐', 'scr', 'creatinine', 'cr'], 'laboratory', 'umol/L'),
  concept('EGFR_CKD_EPI_2021', '估算肾小球滤过率', ['egfr'], 'derived', 'mL/min/{1.73_m2}'),
  concept('URIC_ACID', '尿酸', ['血尿酸', 'ua', 'uric acid'], 'laboratory', 'umol/L'),
  concept('UREA', '尿素', ['urea'], 'laboratory', 'mmol/L'),
  concept('BUN', '尿素氮', ['bun', 'blood urea nitrogen'], 'laboratory', 'mg/dL'),
  concept('BILIRUBIN_TOTAL', '总胆红素', ['总胆红素', 'tbil'], 'laboratory', 'umol/L'),
  concept('CALCIUM', '钙', ['血钙', 'ca'], 'laboratory', 'mmol/L'),
  concept('PHOSPHORUS', '磷', ['血磷', 'p'], 'laboratory', 'mmol/L'),
  concept('HEMOGLOBIN', '血红蛋白', ['血红蛋白', 'hb', 'hgb'], 'laboratory', 'g/L'),
  concept('FERRITIN', '铁蛋白', ['铁蛋白', 'fer'], 'laboratory', 'ng/mL'),
  concept('ALT', '丙氨酸氨基转移酶', ['谷丙转氨酶', 'alt'], 'laboratory', 'U/L'),
  concept('AST', '天门冬氨酸氨基转移酶', ['谷草转氨酶', 'ast'], 'laboratory', 'U/L'),
  concept('GGT', 'γ-谷氨酰转移酶', ['谷氨酰转肽酶', 'ggt'], 'laboratory', 'U/L'),
  concept('BP_SYSTOLIC', '收缩压', ['高压', '收缩压', 'sbp'], 'vital', 'mm[Hg]'),
  concept('BP_DIASTOLIC', '舒张压', ['低压', '舒张压', 'dbp'], 'vital', 'mm[Hg]'),
  concept('WEIGHT', '体重', ['weight'], 'anthropometric', 'kg'),
  concept('HEIGHT', '身高', ['height'], 'anthropometric', 'cm'),
  concept('WAIST_CIRCUMFERENCE', '腰围', ['waist'], 'anthropometric', 'cm'),
  concept('BMI', '身体质量指数', ['bmi'], 'derived', 'kg/m2'),

  // ── 血常规(m5-02)。加进来是因为自洽校验必须能确定"哪一行是 WBC" ——
  //    别名以中文报告上的括号缩写为准(白细胞(WBC) / 中性粒细胞比例(Neu%)),
  //    那是国内化验单里最稳定的标识。缺了它们,整张血常规都无法交叉验证。
  concept('WBC', '白细胞', ['白细胞', 'wbc', '白细胞计数'], 'laboratory', '10*9/L'),
  concept('NEUT_PCT', '中性粒细胞比例', ['中性粒细胞比例', 'neu%', 'neut%', '中性粒细胞百分比'], 'laboratory', '%'),
  concept('LYMPH_PCT', '淋巴细胞比例', ['淋巴细胞比例', 'lym%', 'lymph%', '淋巴细胞百分比'], 'laboratory', '%'),
  concept('MONO_PCT', '单核细胞比例', ['单核细胞比例', 'mon%', 'mono%', '单核细胞百分比'], 'laboratory', '%'),
  concept('EO_PCT', '嗜酸性粒细胞比例', ['嗜酸性粒细胞比例', 'eos%', 'eo%'], 'laboratory', '%'),
  concept('BASO_PCT', '嗜碱性粒细胞比例', ['嗜碱性粒细胞比例', 'bas%', 'baso%'], 'laboratory', '%'),
  concept('NEUT_ABS', '中性粒细胞绝对值', ['中性粒细胞绝对值', 'neu#', 'neut#'], 'laboratory', '10*9/L'),
  concept('LYMPH_ABS', '淋巴细胞绝对值', ['淋巴细胞绝对值', 'lym#', 'lymph#'], 'laboratory', '10*9/L'),
  concept('MONO_ABS', '单核细胞绝对值', ['单核细胞绝对值', 'mon#', 'mono#'], 'laboratory', '10*9/L'),
  concept('EO_ABS', '嗜酸性粒细胞绝对值', ['嗜酸性粒细胞绝对值', 'eos#', 'eo#'], 'laboratory', '10*9/L'),
  concept('BASO_ABS', '嗜碱性粒细胞绝对值', ['嗜碱性粒细胞绝对值', 'bas#', 'baso#'], 'laboratory', '10*9/L'),
  concept('RBC', '红细胞', ['红细胞', 'rbc', '红细胞计数'], 'laboratory', '10*12/L'),
  concept('HCT', '红细胞压积', ['红细胞压积', 'hct', '血细胞比容'], 'laboratory', '%'),
  concept('MCV', '红细胞平均体积', ['红细胞平均体积', 'mcv', '平均红细胞体积'], 'laboratory', 'fL'),
  concept('MCH', '平均血红蛋白含量', ['平均血红蛋白含量', 'mch'], 'laboratory', 'pg'),
  concept('MCHC', '平均血红蛋白浓度', ['平均血红蛋白浓度', 'mchc'], 'laboratory', 'g/L'),
  concept('PLT', '血小板', ['血小板', 'plt', '血小板计数'], 'laboratory', '10*9/L'),
  concept('MPV', '血小板平均体积', ['血小板平均体积', 'mpv'], 'laboratory', 'fL'),
  concept('PCT_PLATELET', '血小板压积', ['血小板压积', 'pct'], 'laboratory', '%'),
  concept('P_LCR', '大血小板比例', ['大血小板比例', 'p-lcr', 'plcr'], 'laboratory', '%'),
  concept('P_LCC', '大血小板数目', ['大血小板数目', 'p-lcc', 'plcc'], 'laboratory', '10*9/L'),
  concept('NLR', '中性粒细胞与淋巴细胞比值', ['中性粒细胞与淋巴细胞比值', 'nlr'], 'derived', '1'),
  concept('PLR', '血小板与淋巴细胞比值', ['血小板与淋巴细胞比值', 'plr'], 'derived', '1'),
  // 这几项没有可交叉验算的冗余(review_status 会是 unverified),但它们是标准血常规项目,
  // 收进目录是为了不让它们无谓地堆进「待整理指标名称」—— 那是可省的人工。
  concept('RDW_CV', '红细胞变异系数', ['红细胞变异系数', 'rdw-cv', 'rdwcv'], 'laboratory', '%'),
  concept('RDW_SD', '红细胞分布宽度标准差', ['分布宽度标准差', '红细胞分布宽度标准差', 'rdw-sd', 'rdwsd'], 'laboratory', 'fL'),
  concept('PDW', '血小板分布宽度', ['血小板分布宽度', 'pdw'], 'laboratory', 'fL'),
  concept('CRP', 'C反应蛋白', ['c反应蛋白', 'crp', '超敏c反应蛋白', 'hs-crp'], 'laboratory', 'mg/L'),
] as const;

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/[\s_]+/g, '');
}

export function conceptByCode(code: string): MedicalConcept | null {
  const needle = code.trim().toUpperCase();
  return CONCEPT_CATALOG.find((item) => item.code === needle) ?? null;
}

export function searchConcepts(
  query: string,
  options: { kind?: MedicalConceptKind; limit?: number } = {},
): MedicalConcept[] {
  const needle = normalized(query);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  return CONCEPT_CATALOG
    .filter((item) => !options.kind || item.kind === options.kind)
    .map((item) => {
      const names = [item.code, item.display_name, ...item.aliases].map(normalized);
      const exact = names.some((name) => name === needle);
      const prefix = names.some((name) => name.startsWith(needle));
      const contains = needle === '' || names.some((name) => name.includes(needle));
      return { item, rank: exact ? 0 : prefix ? 1 : contains ? 2 : 3 };
    })
    .filter(({ rank }) => rank < 3)
    .sort((left, right) => left.rank - right.rank || left.item.code.localeCompare(right.item.code))
    .slice(0, limit)
    .map(({ item }) => item);
}

/**
 * **严格**名称解析:只在完全相等(归一化后)时返回概念,否则 null。
 *
 * 与 searchConcepts 的模糊包含匹配刻意不同 —— 自洽校验必须确定"这一行到底是不是 WBC"。
 * 认错行会产出**假的校验结论**,那比不校验更危险:它会给一个没被验证过的数字盖上"已验证"的章。
 * 拿不准就返回 null,让该行落到"无法交叉验证"那一类,交给人看。
 *
 * 化验单常见写法「白细胞(WBC)」会同时按整串、中文段和括号内缩写各试一次。
 */
export function conceptByExactName(rawName: string): MedicalConcept | null {
  const candidates = new Set<string>();
  const push = (v: string) => { const n = normalized(v); if (n) candidates.add(n); };
  push(rawName);
  const paren = /^(.*?)[（(]([^）)]+)[）)]\s*$/.exec(rawName.trim());
  if (paren) { push(paren[1]!); push(paren[2]!); }

  for (const item of CONCEPT_CATALOG) {
    const names = [item.code, item.display_name, ...item.aliases].map(normalized);
    if (names.some((name) => candidates.has(name))) return item;
  }
  return null;
}
