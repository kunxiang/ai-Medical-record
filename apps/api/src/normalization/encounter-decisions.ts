import { inArray } from 'drizzle-orm';
import { EncounterProposal } from '@amr/contracts';
import type { Tx } from '../db/client.js';
import { document, encounter } from '../db/schema.js';

export class EncounterDecisionFailure extends Error {
  constructor(
    readonly terminal: 'needs_human' | 'failed',
    readonly detail: { stage: string; code: string; message: string; category?: string | null },
  ) {
    super(detail.message);
  }
}

/** 人工确认后的确定性执行；Core route 安全导入，不依赖 provider SDK。 */
export async function applyEncounterDecision(
  tx: Tx,
  proposalInput: unknown,
  state: 'confirmed' | 'rejected',
  audit?: { accountId: string; at: string },
): Promise<string | null> {
  const proposal = EncounterProposal.parse(proposalInput);
  if (state === 'rejected') return null;
  const documents = await tx.select({
    id: document.id, personId: document.personId, facilityId: document.facilityId,
    encounterId: document.encounterId,
  }).from(document).where(inArray(document.id, proposal.document_ids));
  if (documents.length !== proposal.document_ids.length
      || documents.some((item) => item.personId !== proposal.person_id || item.facilityId !== proposal.facility_id)) {
    throw new EncounterDecisionFailure('needs_human', {
      stage: 'encounter_confirm', code: 'documents_changed', message: '候选文档的归属或机构已经变化，请重新生成建议',
    });
  }
  if (documents.some((item) => item.encounterId !== null && item.encounterId !== proposal.encounter_id)) {
    throw new EncounterDecisionFailure('needs_human', {
      stage: 'encounter_confirm', code: 'already_grouped', message: '至少一份候选文档已归入其他就诊',
    });
  }
  await tx.insert(encounter).values({
    id: proposal.encounter_id, personId: proposal.person_id,
    encounterType: proposal.encounter_type, facilityId: proposal.facility_id,
    department: proposal.department, occurredOn: proposal.occurred_on,
    occurredAt: proposal.occurred_at ? new Date(proposal.occurred_at) : null,
    groupingBasis: proposal.grouping_basis,
    updatedBy: audit?.accountId ?? null,
    updatedAt: audit ? new Date(audit.at) : new Date(),
  }).onConflictDoNothing({ target: encounter.id });
  await tx.update(document).set({ encounterId: proposal.encounter_id })
    .where(inArray(document.id, proposal.document_ids));
  return proposal.encounter_id;
}
