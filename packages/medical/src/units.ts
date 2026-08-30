import { conceptByCode } from './concepts.js';

export const CONVERSION_VERSION = 'medical-units@1';

export interface ConvertedValue {
  value: number;
  unit: string;
  version: string;
}

export interface RelatedConceptConversion extends ConvertedValue {
  concept_code: 'UREA' | 'BUN';
}

const unitAlias: Readonly<Record<string, string>> = {
  'μmol/l': 'umol/L', 'µmol/l': 'umol/L', 'umol/l': 'umol/L',
  'mmol/l': 'mmol/L', 'mg/dl': 'mg/dL', 'g/l': 'g/L', 'g/dl': 'g/dL',
  'ng/ml': 'ng/mL', 'pmol/l': 'pmol/L', 'u/l': 'U/L', '%': '%',
  'mmhg': 'mm[Hg]', 'mm[hg]': 'mm[Hg]', 'kg': 'kg', 'cm': 'cm',
  'kg/m2': 'kg/m2', 'mmol/mol': 'mmol/mol',
  'ml/min/1.73m2': 'mL/min/{1.73_m2}', 'ml/min/{1.73_m2}': 'mL/min/{1.73_m2}',
};

export function canonicalUcum(input: string): string | null {
  return unitAlias[input.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '')] ?? null;
}

function rounded(value: number): number {
  return Number(value.toPrecision(12));
}

/** 接受已经显式识别的 UCUM；不从陌生文字猜单位。 */
export function convertToCanonical(
  conceptCode: string,
  value: number,
  unit: string,
): ConvertedValue | null {
  if (!Number.isFinite(value)) return null;
  const concept = conceptByCode(conceptCode);
  if (!concept) return null;
  const canonical = canonicalUcum(unit) ?? unit;
  if (canonical === concept.canonical_unit) {
    return { value, unit: canonical, version: CONVERSION_VERSION };
  }
  const pair = `${concept.code}:${canonical}->${concept.canonical_unit}`;
  const converted = pair === 'GLUCOSE:mg/dL->mmol/L' ? value / 18.016
    : ['TOTAL_CHOLESTEROL', 'LDL_C', 'HDL_C', 'NON_HDL_C'].includes(concept.code)
        && canonical === 'mg/dL' ? value / 38.67
      : concept.code === 'TRIGLYCERIDES' && canonical === 'mg/dL' ? value / 88.57
      : concept.code === 'CREATININE' && canonical === 'mg/dL' ? value * 88.4
      : concept.code === 'URIC_ACID' && canonical === 'mg/dL' ? value * 59.48
      : concept.code === 'BILIRUBIN_TOTAL' && canonical === 'mg/dL' ? value * 17.1
      : concept.code === 'CALCIUM' && canonical === 'mg/dL' ? value / 4.008
      : concept.code === 'PHOSPHORUS' && canonical === 'mg/dL' ? value / 3.097
      : concept.code === 'HEMOGLOBIN' && canonical === 'g/dL' ? value * 10
      : concept.code === 'FERRITIN' && canonical === 'pmol/L' ? value / 2.247
      : concept.code === 'HBA1C' && canonical === 'mmol/mol' ? 0.09148 * value + 2.152
      : null;
  return converted === null ? null : {
    value: rounded(converted), unit: concept.canonical_unit, version: CONVERSION_VERSION,
  };
}

/** 规格中的稳定入口；canonical unit 是该 concept 的确定性 SI/展示单位。 */
export const convertToSi = convertToCanonical;

/**
 * 尿素和尿素氮是不同 measurand。跨两者换算必须显式改变 concept，
 * 不能把它伪装成 UREA 或 BUN 内部的普通单位换算。
 */
export function convertUreaBun(
  sourceConcept: 'UREA' | 'BUN',
  value: number,
  unit: string,
  targetConcept: 'UREA' | 'BUN',
): RelatedConceptConversion | null {
  if (!Number.isFinite(value) || sourceConcept === targetConcept) return null;
  const canonical = canonicalUcum(unit);
  if (sourceConcept === 'UREA' && targetConcept === 'BUN' && canonical === 'mmol/L') {
    return { concept_code: 'BUN', value: rounded(value * 2.8), unit: 'mg/dL', version: CONVERSION_VERSION };
  }
  if (sourceConcept === 'BUN' && targetConcept === 'UREA' && canonical === 'mg/dL') {
    return { concept_code: 'UREA', value: rounded(value / 2.8), unit: 'mmol/L', version: CONVERSION_VERSION };
  }
  return null;
}
