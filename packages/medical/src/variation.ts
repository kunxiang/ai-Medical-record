const cvi: Readonly<Record<string, number>> = {
  HBA1C: 0.02, ALBUMIN: 0.03, HEMOGLOBIN: 0.03, CREATININE: 0.05,
  GLUCOSE: 0.06, TOTAL_CHOLESTEROL: 0.06, HDL_C: 0.07, LDL_C: 0.08,
  URIC_ACID: 0.09, AST: 0.12, ALT: 0.19, TRIGLYCERIDES: 0.20, TSH: 0.19,
};

export const RCV_VERSION = 'rcv@1';

export function referenceChangeValue(
  conceptCode: string,
  options: { cva?: number; z?: number } = {},
): { rcvPercent: number; cvi: number; cva: number; z: number; version: string } | null {
  const within = cvi[conceptCode.toUpperCase()];
  if (within === undefined) return null;
  const cva = options.cva ?? 0.03;
  const z = options.z ?? 1.96;
  if (cva < 0 || z <= 0) return null;
  const percent = Math.sqrt(2) * z * Math.sqrt(cva * cva + within * within) * 100;
  return { rcvPercent: Number(percent.toFixed(2)), cvi: within, cva, z, version: RCV_VERSION };
}

export function exceedsRcv(conceptCode: string, previous: number, current: number): boolean | null {
  if (!Number.isFinite(previous) || !Number.isFinite(current) || previous === 0) return null;
  const rcv = referenceChangeValue(conceptCode);
  if (!rcv) return null;
  return Math.abs((current - previous) / previous) * 100 > rcv.rcvPercent;
}
