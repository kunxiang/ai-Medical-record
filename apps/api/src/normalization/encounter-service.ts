import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  EncounterCandidateDocument, EncounterProposal, type EncounterCandidateDocumentT,
  type EncounterProposalT,
} from '@amr/contracts';
import { callEncounterSuggestion, EncounterSuggestionError } from '@amr/ai';
import { uuidv7 } from 'uuidv7';
import { db, type Tx } from '../db/client.js';
import { account, document, encounter, normalizationDecision } from '../db/schema.js';
import { encounterCandidatePairs, proposalsFromEncounterJudgments } from './encounter-candidates.js';
import { encounterFingerprint, encounterPairFingerprint } from './encounter-fingerprint.js';

export class EncounterJobFailure extends Error {
  constructor(
    readonly terminal: 'needs_human' | 'failed',
    readonly detail: { stage: string; code: string; message: string; category?: string | null },
  ) {
    super(detail.message);
  }
}

async function ungroupedDocuments(personId: string): Promise<EncounterCandidateDocumentT[]> {
  const rows = await db.select({
    id: document.id, shortId: document.shortId, facilityId: document.facilityId,
    docType: document.docType, eventTime: document.eventTime, sampledOn: document.sampledOn,
    reportedOn: document.reportedOn, captureDate: document.captureDate,
    departmentRaw: document.departmentRaw, timezone: account.timezone,
  }).from(document).innerJoin(account, eq(account.id, document.uploadedBy)).where(and(
    eq(document.personId, personId), isNull(document.encounterId),
    isNull(document.archivedAt), isNotNull(document.facilityId),
  ));
  return rows.map((row) => EncounterCandidateDocument.parse({
    id: row.id, short_id: row.shortId, facility_id: row.facilityId,
    doc_type: row.docType, event_time: row.eventTime?.toISOString() ?? null,
    sampled_on: row.sampledOn, reported_on: row.reportedOn, capture_date: row.captureDate,
    department_raw: row.departmentRaw, timezone: row.timezone,
  }));
}

/** 人工确认后的确定性执行。AI handler 绝不会调用它。 */
export async function applyEncounterDecision(
  tx: Tx,
  proposalInput: unknown,
  state: 'confirmed' | 'rejected',
): Promise<string | null> {
  const proposal = EncounterProposal.parse(proposalInput);
  if (state === 'rejected') return null;
  const documents = await tx.select({
    id: document.id, personId: document.personId, facilityId: document.facilityId,
    encounterId: document.encounterId,
  }).from(document).where(inArray(document.id, proposal.document_ids));
  if (documents.length !== proposal.document_ids.length
      || documents.some((item) => item.personId !== proposal.person_id || item.facilityId !== proposal.facility_id)) {
    throw new EncounterJobFailure('needs_human', {
      stage: 'encounter_confirm', code: 'documents_changed', message: '候选文档的归属或机构已经变化，请重新生成建议',
    });
  }
  if (documents.some((item) => item.encounterId !== null && item.encounterId !== proposal.encounter_id)) {
    throw new EncounterJobFailure('needs_human', {
      stage: 'encounter_confirm', code: 'already_grouped', message: '至少一份候选文档已归入其他就诊',
    });
  }
  await tx.insert(encounter).values({
    id: proposal.encounter_id, personId: proposal.person_id,
    encounterType: proposal.encounter_type, facilityId: proposal.facility_id,
    department: proposal.department, occurredOn: proposal.occurred_on,
    occurredAt: proposal.occurred_at ? new Date(proposal.occurred_at) : null,
    groupingBasis: proposal.grouping_basis,
  }).onConflictDoNothing({ target: encounter.id });
  await tx.update(document).set({ encounterId: proposal.encounter_id })
    .where(inArray(document.id, proposal.document_ids));
  return proposal.encounter_id;
}

export async function handleEncounterSuggest(personId: string): Promise<{ decisionIds: string[] }> {
  const documents = await ungroupedDocuments(personId);
  const allPairs = encounterCandidatePairs(documents);
  if (allPairs.length === 0) return { decisionIds: [] };

  const fingerprints = allPairs.map((pair) => encounterPairFingerprint(personId, pair));
  const cached = await db.select({ inputFingerprint: normalizationDecision.inputFingerprint })
    .from(normalizationDecision).where(and(
      eq(normalizationDecision.kind, 'encounter'),
      inArray(normalizationDecision.inputFingerprint, fingerprints),
    ));
  const cachedSet = new Set(cached.map((item) => item.inputFingerprint));
  const pairs = allPairs.filter((pair) => !cachedSet.has(encounterPairFingerprint(personId, pair)));
  if (pairs.length === 0) return { decisionIds: [] };

  let result: Awaited<ReturnType<typeof callEncounterSuggestion>>;
  try {
    result = await callEncounterSuggestion(documents, pairs);
  } catch (error) {
    if (error instanceof EncounterSuggestionError) {
      throw new EncounterJobFailure('needs_human', {
        stage: 'encounter', code: error.kind, message: error.message,
      });
    }
    throw error;
  }

  let proposals: EncounterProposalT[];
  try {
    proposals = proposalsFromEncounterJudgments(personId, documents, pairs, result.output);
  } catch (error) {
    throw new EncounterJobFailure('needs_human', {
      stage: 'encounter', code: 'invalid_candidate_reference',
      message: error instanceof Error ? error.message : '模型返回的候选引用无效',
    });
  }
  if (proposals.length === 0) return { decisionIds: [] };

  return db.transaction(async (tx) => {
    const decisionIds: string[] = [];
    for (const proposal of proposals) {
      const fingerprint = encounterFingerprint(proposal);
      const inserted = await tx.insert(normalizationDecision).values({
        id: uuidv7(), kind: 'encounter', inputFingerprint: fingerprint,
        proposal, state: 'proposed', promptId: result.promptId,
        promptVersion: result.promptVersion, model: result.model,
      }).onConflictDoNothing({ target: normalizationDecision.inputFingerprint })
        .returning({ id: normalizationDecision.id });
      if (inserted[0]) decisionIds.push(inserted[0].id);
    }
    return { decisionIds };
  });
}
