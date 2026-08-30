import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

export const ManualGateId = z.enum([
  'P0-owner-ui',
  'P0-11',
  'P1-6',
  'P1-10',
  'P2-10-desktop',
  'P2-10-mobile',
  'P3-owner-ui',
  'P4-11',
  'P4-artifact-review',
  'release-log-redaction',
]);

export const ManualGateResult = z.object({
  id: ManualGateId,
  status: z.enum(['pending', 'pass', 'fail']),
  tester_id: z.string().min(1).max(100),
  device: z.string().min(1).max(200),
  duration_seconds: z.number().min(0).nullable(),
  background_seconds: z.number().min(0).nullable(),
  evidence_refs: z.array(z.string().min(1)).max(20),
  notes: z.string().max(2_000),
}).strict();

export const DoctorReadabilityTrial = z.object({
  tester_id: z.string().min(1).max(100),
  sample_id: z.string().min(1).max(200),
  sample_kind: z.literal('deidentified_real'),
  locate_seconds: z.number().positive().max(60),
  latest_value_correct: z.boolean(),
  change_correct: z.boolean(),
  source_correct: z.boolean(),
  evidence_ref: z.string().min(1),
  notes: z.string().max(2_000),
}).strict();

export const ManualAcceptanceReport = z.object({
  schema_version: z.literal('1.0'),
  environment: z.string().min(1).max(500),
  processing_mode: z.literal('off'),
  recorded_at: z.string().datetime({ offset: true }),
  gates: z.array(ManualGateResult),
  doctor_trials: z.array(DoctorReadabilityTrial).max(5),
}).strict();

export type ManualAcceptanceReportT = z.infer<typeof ManualAcceptanceReport>;

const REQUIRED_GATES = ManualGateId.options;
const DURATION_LIMITS: Partial<Record<z.infer<typeof ManualGateId>, {
  seconds: number;
  inclusive: boolean;
}>> = {
  'P0-11': { seconds: 60, inclusive: false },
  'P1-10': { seconds: 90, inclusive: false },
  'P2-10-desktop': { seconds: 180, inclusive: true },
  'P2-10-mobile': { seconds: 300, inclusive: true },
  'P4-11': { seconds: 30, inclusive: true },
};

export interface ManualAcceptanceEvaluation {
  passed: boolean;
  errors: string[];
  doctor_median_seconds: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function evaluateManualAcceptance(report: ManualAcceptanceReportT): ManualAcceptanceEvaluation {
  const errors: string[] = [];
  const gateMap = new Map(report.gates.map((gate) => [gate.id, gate]));
  if (gateMap.size !== report.gates.length) errors.push('人工 gate id 不得重复');

  for (const id of REQUIRED_GATES) {
    const gate = gateMap.get(id);
    if (!gate) {
      errors.push(`${id}: 缺少记录`);
      continue;
    }
    if (gate.status !== 'pass') errors.push(`${id}: 状态为 ${gate.status}`);
    if (gate.status === 'pass' && gate.evidence_refs.length === 0) {
      errors.push(`${id}: PASS 必须附证据引用`);
    }
    const limit = DURATION_LIMITS[id];
    if (limit) {
      if (gate.duration_seconds === null) {
        errors.push(`${id}: 缺少用户操作耗时`);
      } else if (limit.inclusive
        ? gate.duration_seconds > limit.seconds
        : gate.duration_seconds >= limit.seconds) {
        errors.push(`${id}: ${gate.duration_seconds}s 超过门槛${limit.inclusive ? '≤' : '<'}${limit.seconds}s`);
      }
    }
  }

  const uniqueDoctors = new Set(report.doctor_trials.map((trial) => trial.tester_id));
  if (report.doctor_trials.length < 3 || report.doctor_trials.length > 5) {
    errors.push('P4-12: 必须记录 3–5 名医生');
  }
  if (uniqueDoctors.size !== report.doctor_trials.length) {
    errors.push('P4-12: 每名医生只能记录一次汇总成绩');
  }
  for (const trial of report.doctor_trials) {
    if (!trial.latest_value_correct || !trial.change_correct || !trial.source_correct) {
      errors.push(`P4-12/${trial.tester_id}: 最新值、变化和来源必须全部定位正确`);
    }
  }
  const doctorMedian = median(report.doctor_trials.map((trial) => trial.locate_seconds));
  if (doctorMedian === null || doctorMedian > 3) {
    errors.push(`P4-12: 医生定位中位数必须 ≤3s，当前为 ${doctorMedian ?? '无记录'}`);
  }

  return { passed: errors.length === 0, errors, doctor_median_seconds: doctorMedian };
}

async function main(): Promise<void> {
  const reportPath = process.argv.slice(2).find((argument) => argument !== '--');
  if (!reportPath) throw new Error('usage: tsx src/manual-acceptance.ts <report.json>');
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const absoluteReportPath = resolve(repoRoot, reportPath);
  const report = ManualAcceptanceReport.parse(JSON.parse(await readFile(absoluteReportPath, 'utf8')));
  const evaluation = evaluateManualAcceptance(report);
  process.stdout.write(`Manual acceptance: ${evaluation.passed ? 'PASS' : 'INCOMPLETE'}\n`);
  process.stdout.write(`P4-12 doctor median: ${evaluation.doctor_median_seconds === null
    ? 'n/a' : `${evaluation.doctor_median_seconds}s`}\n`);
  for (const error of evaluation.errors) process.stdout.write(`  - ${error}\n`);
  if (!evaluation.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
