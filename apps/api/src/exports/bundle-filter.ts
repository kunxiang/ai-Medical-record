import { DecisionLine, EncounterDecisionPayload, FacilityProposal } from '@amr/contracts';

type Decision = ReturnType<typeof DecisionLine.parse>;

export function filterDecisionForPerson(
  decision: Decision,
  personId: string,
  targetFacilityRawNames: ReadonlySet<string>,
): Decision | null {
  if (decision.kind === 'facility') {
    const proposal = FacilityProposal.safeParse(decision.payload);
    if (!proposal.success) return null;
    const matchedRawNames = proposal.data.matched_raw_names.filter((name) => targetFacilityRawNames.has(name));
    if (matchedRawNames.length === 0) return null;
    return { ...decision, payload: { ...proposal.data, matched_raw_names: matchedRawNames } };
  }
  const payload = EncounterDecisionPayload.safeParse(decision.payload);
  return payload.success && payload.data.person_id === personId ? decision : null;
}
