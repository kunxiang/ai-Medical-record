import { describe, expect, it } from 'vitest';
import type { EncounterCandidateDocumentT } from '@amr/contracts';
import { eligibleEncounterPair, encounterCandidatePairs, proposalsFromEncounterJudgments } from '../src/normalization/encounter-candidates.js';

const personId = '00000000-0000-4000-8000-000000000001';
const facilityId = '00000000-0000-4000-8000-000000000002';
const id = (tail: number) => `00000000-0000-4000-8000-${String(tail).padStart(12, '0')}`;
const shortId = (tail: number) => `d2345${['6', '7', '8'][tail - 1]}`;
const doc = (tail: number, overrides: Partial<EncounterCandidateDocumentT> = {}): EncounterCandidateDocumentT => ({
  id: id(tail), short_id: shortId(tail), facility_id: facilityId, doc_type: 'lab_report',
  event_time: null, sampled_on: '2026-08-20', reported_on: null, capture_date: '2026-08-20',
  department_raw: '检验科', timezone: 'UTC', ...overrides,
});

describe('encounter deterministic candidate engine', () => {
  it('双时分 11h 命中，13h 不命中', () => {
    expect(eligibleEncounterPair(doc(1, { event_time: '2026-08-20T01:00:00Z' }), doc(2, { event_time: '2026-08-20T12:00:00Z' }))?.grouping_basis).toBe('event_time');
    expect(eligibleEncounterPair(doc(1, { event_time: '2026-08-20T01:00:00Z' }), doc(2, { event_time: '2026-08-20T14:00:00Z' }))).toBeNull();
  });

  it('双无时分时相邻日降级命中，隔两日不命中', () => {
    expect(eligibleEncounterPair(doc(1), doc(2, { sampled_on: '2026-08-21' }))?.grouping_basis).toBe('capture_date_degraded');
    expect(eligibleEncounterPair(doc(1), doc(2, { sampled_on: '2026-08-22' }))).toBeNull();
  });

  it('仅一侧有时分时与另一侧全天区间求交', () => {
    expect(eligibleEncounterPair(doc(1, { event_time: '2026-08-20T23:59:59Z' }), doc(2))?.grouping_basis).toBe('event_time');
    expect(eligibleEncounterPair(doc(1, { event_time: '2026-08-21T00:00:00Z' }), doc(2))).toBeNull();
  });

  it('单侧时分按无时分文档的上传者时区判断日界', () => {
    const timed = doc(1, { event_time: '2026-08-19T16:30:00Z' });
    const untimed = doc(2, { timezone: 'Asia/Shanghai', sampled_on: '2026-08-20' });
    expect(eligibleEncounterPair(timed, untimed)?.grouping_basis).toBe('event_time');
  });

  it('拒绝模型扩张候选边界，并只把同次判断转成提议', () => {
    const documents = [doc(1), doc(2, { sampled_on: '2026-08-21' }), doc(3, { sampled_on: '2026-08-24' })];
    const pairs = encounterCandidatePairs(documents);
    const proposals = proposalsFromEncounterJudgments(personId, documents, pairs, { judgments: [{
      document_ids: [id(1), id(2)], same_encounter: true, encounter_type: 'outpatient', confidence: 0.8, reason: '同院相邻日且项目连续',
    }] });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.grouping_basis).toBe('capture_date_degraded');
    expect(() => proposalsFromEncounterJudgments(personId, documents, pairs, { judgments: [{
      document_ids: [id(1), id(3)], same_encounter: true, encounter_type: 'other', confidence: 0.2, reason: '越界',
    }] })).toThrow(/预筛之外/);
  });
});
