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
