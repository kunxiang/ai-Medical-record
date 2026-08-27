import { FacilityProposal, type FacilityProposalT } from '@amr/contracts';
import type { FacilityCandidateInput, FacilityNormalizationResult } from '@amr/ai';
import { newFacilitySlug } from '@amr/storage';

export interface FacilityFailureDetail {
  stage: string;
  code: string;
  message: string;
  category?: string | null;
}

export class FacilityJobFailure extends Error {
  constructor(
    readonly terminal: 'needs_human' | 'failed',
    readonly detail: FacilityFailureDetail,
  ) {
    super(detail.message);
  }
}

export function fingerprintFromFacilityDedup(value: string): string {
  const match = /^facility:([0-9a-f]{64})$/.exec(value);
  if (!match) {
    throw new FacilityJobFailure('failed', {
      stage: 'facility', code: 'invalid_dedup_key', message: 'facility 作业的 dedup_key 无效',
    });
  }
  return match[1]!;
}

export function finalFacilityProposal(
  output: FacilityNormalizationResult['output'],
  existing: FacilityCandidateInput[],
  rawNames: string[],
): FacilityProposalT {
  if (output.action === 'match_existing') {
    const hit = existing.find((item) => item.slug === output.existing_facility_slug);
    if (!hit) {
      throw new FacilityJobFailure('needs_human', {
        stage: 'facility', code: 'unknown_facility_slug', message: '模型引用了不存在的机构 slug',
      });
    }
    return FacilityProposal.parse({
      facility: { slug: hit.slug, name: hit.name, city: hit.city, level: hit.level },
      matched_raw_names: rawNames,
      confidence: output.confidence,
      reason: output.reason,
    });
  }
  return FacilityProposal.parse({
    facility: {
      slug: newFacilitySlug(), name: output.name, city: output.city, level: output.level,
    },
    matched_raw_names: rawNames,
    confidence: output.confidence,
    reason: output.reason,
  });
}
