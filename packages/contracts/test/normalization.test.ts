import { describe, expect, it } from 'vitest';
import { EncounterDecisionPayload, EncounterProposal, normalizeIdentity } from '../src/normalization.js';

describe('normalizeIdentity(m2-05 §1.3)', () => {
  it('按固定顺序做 NFKC、小写、空白和分隔符归一', () => {
    expect(normalizeIdentity(' ＡＢＣ·医 院 ')).toBe('abc医院');
    expect(normalizeIdentity('阿依古丽・买买提')).toBe('阿依古丽买买提');
    expect(normalizeIdentity('Smith_Jones/Clinic')).toBe('smithjonesclinic');
  });

  it('不做模糊或形近字符折叠', () => {
    expect(normalizeIdentity('张伟')).not.toBe(normalizeIdentity('张玮'));
  });
});

describe('EncounterDecisionPayload', () => {
  const proposal = {
    encounter_id: '01890f00-0000-7000-8000-000000000001',
    person_id: '01890f00-0000-7000-8000-000000000002',
    document_ids: [
      '01890f00-0000-7000-8000-000000000003',
      '01890f00-0000-7000-8000-000000000004',
    ],
    document_short_ids: ['d23456', 'd23457'],
    facility_id: '01890f00-0000-7000-8000-000000000005',
    grouping_basis: 'event_time', encounter_type: 'outpatient',
    occurred_on: '2026-08-27', occurred_at: '2026-08-27T08:00:00Z',
    department: '儿科', confidence: 0.9, reason: '同次就诊',
  };

  it('在基础 proposal 外封存可重建的 facility 行', () => {
    expect(EncounterProposal.parse(proposal)).toEqual(proposal);
    expect(EncounterDecisionPayload.parse({
      ...proposal,
      facility: {
        id: proposal.facility_id, slug: 'f23456', name: '测试医院',
        aliases: ['测试医院'], city: '测试市', level: '三级',
      },
    }).facility.id).toBe(proposal.facility_id);
  });

  it('缺 facility 快照时不会被误当成可完整回放载荷', () => {
    expect(EncounterDecisionPayload.safeParse(proposal).success).toBe(false);
  });
});
