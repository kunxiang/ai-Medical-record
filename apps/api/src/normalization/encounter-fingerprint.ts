import { createHash } from 'node:crypto';
import { canonicalJsonString, type EncounterCandidatePairT, type EncounterProposalT } from '@amr/contracts';

export function encounterPairFingerprint(personId: string, pair: EncounterCandidatePairT): string {
  const canonical = canonicalJsonString({
    kind: 'encounter', person_id: personId,
    document_ids: [...pair.document_ids].sort(), grouping_basis: pair.grouping_basis,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function encounterFingerprint(proposal: EncounterProposalT): string {
  return encounterPairFingerprint(proposal.person_id, {
    document_ids: proposal.document_ids as [string, string],
    grouping_basis: proposal.grouping_basis,
  });
}
