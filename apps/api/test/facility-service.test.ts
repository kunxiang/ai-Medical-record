import { describe, expect, it } from 'vitest';
import {
  FacilityJobFailure, finalFacilityProposal, fingerprintFromFacilityDedup,
} from '../src/normalization/facility-planning.js';

const existing = [{
  slug: 'f3f7a2', name: '市第一医院', aliases: ['市一院'], city: '深圳', level: null,
}];

describe('facility service deterministic boundary', () => {
  it('只接受 facility:<sha256> 作业键', () => {
    expect(fingerprintFromFacilityDedup(`facility:${'a'.repeat(64)}`)).toBe('a'.repeat(64));
    expect(() => fingerprintFromFacilityDedup('facility:not-a-hash')).toThrow(FacilityJobFailure);
  });

  it('匹配既有机构时使用 DB 快照，不信任模型改写的机构事实', () => {
    const proposal = finalFacilityProposal({
      action: 'match_existing', existing_facility_slug: 'f3f7a2',
      name: '模型擅自改名', city: '模型擅自改城', level: '模型擅自升级',
      confidence: 0.99, reason: '别名命中',
    }, existing, ['市一院']);
    expect(proposal.facility).toEqual({
      slug: 'f3f7a2', name: '市第一医院', city: '深圳', level: null,
    });
  });

  it('模型引用未知 slug 时进入人工终态', () => {
    expect(() => finalFacilityProposal({
      action: 'match_existing', existing_facility_slug: 'f99999',
      name: '未知', city: null, level: null, confidence: 0.5, reason: '不可靠',
    }, existing, ['未知医院'])).toThrow(FacilityJobFailure);
  });

  it('新建机构的 slug 由执行层生成', () => {
    const proposal = finalFacilityProposal({
      action: 'create', existing_facility_slug: null,
      name: '新医院', city: null, level: null, confidence: 0.7, reason: '无既有候选',
    }, existing, ['新医院']);
    expect(proposal.facility.slug).toMatch(/^f[23456789abcdefghjkmnpqrstvwxyz]{5}$/);
    expect(proposal.facility.name).toBe('新医院');
  });
});
