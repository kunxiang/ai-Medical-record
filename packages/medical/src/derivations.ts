export const DERIVATION_VERSIONS = {
  egfr: 'ckd-epi-2021@1', nonHdl: 'non-hdl@1', bmi: 'bmi@1',
} as const;

export function egfrCkdEpi2021(input: {
  creatinineMgDl: number;
  ageYears: number;
  sexAtBirth: 'male' | 'female' | 'unknown';
}): { value: number; unit: 'mL/min/{1.73_m2}'; version: string } | null {
  if (!Number.isFinite(input.creatinineMgDl) || input.creatinineMgDl <= 0
      || !Number.isFinite(input.ageYears) || input.ageYears < 18
      || input.sexAtBirth === 'unknown') return null;
  const female = input.sexAtBirth === 'female';
  const kappa = female ? 0.7 : 0.9;
  const alpha = female ? -0.241 : -0.302;
  const ratio = input.creatinineMgDl / kappa;
  const value = 142 * Math.pow(Math.min(ratio, 1), alpha)
    * Math.pow(Math.max(ratio, 1), -1.2) * Math.pow(0.9938, input.ageYears)
    * (female ? 1.012 : 1);
  return { value: Number(value.toFixed(2)), unit: 'mL/min/{1.73_m2}', version: DERIVATION_VERSIONS.egfr };
}

export function nonHdlCholesterol(total: number, hdl: number): { value: number; version: string } | null {
  if (![total, hdl].every(Number.isFinite) || total < hdl || hdl < 0) return null;
  return { value: Number((total - hdl).toPrecision(12)), version: DERIVATION_VERSIONS.nonHdl };
}

export function bodyMassIndex(weightKg: number, heightM: number): { value: number; version: string } | null {
  if (!Number.isFinite(weightKg) || !Number.isFinite(heightM) || weightKg <= 0 || heightM <= 0) return null;
  return { value: Number((weightKg / (heightM * heightM)).toFixed(2)), version: DERIVATION_VERSIONS.bmi };
}
