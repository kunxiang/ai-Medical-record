import { describe, expect, it } from 'vitest';
import {
  evaluateManualAcceptance,
  ManualAcceptanceReport,
  type ManualAcceptanceReportT,
} from '../src/manual-acceptance.js';

const gateIds = [
  'P0-owner-ui', 'P0-11', 'P1-6', 'P1-10', 'P2-10-desktop',
  'P2-10-mobile', 'P3-owner-ui', 'P4-11', 'P4-artifact-review', 'release-log-redaction',
] as const;

function passingReport(): ManualAcceptanceReportT {
  return ManualAcceptanceReport.parse({
    schema_version: '1.0',
    environment: 'staging.example.test · build abc123',
    processing_mode: 'off',
    recorded_at: '2026-08-28T11:00:00Z',
    gates: gateIds.map((id) => ({
      id,
      status: 'pass',
      tester_id: 'owner-01',
      device: id.endsWith('mobile') || id === 'P1-6' ? 'mobile browser' : 'desktop browser',
      duration_seconds: id === 'P0-11' ? 59
        : id === 'P1-10' ? 89
          : id === 'P2-10-desktop' ? 180
            : id === 'P2-10-mobile' ? 300
              : id === 'P4-11' ? 30 : null,
      background_seconds: id === 'P4-11' ? 12 : null,
      evidence_refs: [`evidence/${id}.webm`],
      notes: '',
    })),
    doctor_trials: [2.2, 3, 3.4].map((seconds, index) => ({
      tester_id: `doctor-${index + 1}`,
      sample_id: 'real-deidentified-sample-01',
      sample_kind: 'deidentified_real',
      locate_seconds: seconds,
      latest_value_correct: true,
      change_correct: true,
      source_correct: true,
      evidence_ref: `evidence/doctor-${index + 1}.csv`,
      notes: '',
    })),
  });
}

describe('manual P0–P4 acceptance evidence', () => {
  it('accepts complete evidence at the exact inclusive/exclusive thresholds', () => {
    const result = evaluateManualAcceptance(passingReport());
    expect(result).toEqual({ passed: true, errors: [], doctor_median_seconds: 3 });
  });

  it('rejects missing evidence and synthetic/no doctor trials', () => {
    const report = passingReport();
    report.gates = report.gates.filter((gate) => gate.id !== 'P0-11');
    report.doctor_trials = [];
    const result = evaluateManualAcceptance(report);
    expect(result.passed).toBe(false);
    expect(result.errors).toContain('P0-11: 缺少记录');
    expect(result.errors).toContain('P4-12: 必须记录 3–5 名医生');
  });

  it('keeps strict time gates and correctness fail closed', () => {
    const report = passingReport();
    report.gates.find((gate) => gate.id === 'P1-10')!.duration_seconds = 90;
    report.doctor_trials[1]!.source_correct = false;
    const result = evaluateManualAcceptance(report);
    expect(result.passed).toBe(false);
    expect(result.errors).toContain('P1-10: 90s 超过门槛<90s');
    expect(result.errors).toContain('P4-12/doctor-2: 最新值、变化和来源必须全部定位正确');
  });
});
