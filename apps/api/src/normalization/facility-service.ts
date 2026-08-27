import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  FacilityProposal, dedupKey,
} from '@amr/contracts';
import {
  callFacilityNormalization, FacilityNormalizationError,
} from '@amr/ai';
import { db, type Tx } from '../db/client.js';
import { document, facility, normalizationDecision } from '../db/schema.js';
import { enqueue } from '../jobs/queue.js';
import { facilityFingerprint } from './facility-fingerprint.js';
import {
  FacilityJobFailure, finalFacilityProposal, fingerprintFromFacilityDedup,
} from './facility-planning.js';

export { FacilityJobFailure } from './facility-planning.js';

async function matchingRawNames(tx: Tx, fingerprint: string): Promise<string[]> {
  const rows = await tx
    .select({ rawName: document.facilityNameRaw })
    .from(document)
    .where(isNotNull(document.facilityNameRaw));
  return [...new Set(rows
    .map((row) => row.rawName)
    .filter((rawName): rawName is string => rawName !== null && facilityFingerprint(rawName) === fingerprint))];
}

async function matchingDocumentIds(tx: Tx, fingerprint: string): Promise<string[]> {
  const rows = await tx
    .select({ id: document.id, rawName: document.facilityNameRaw })
    .from(document)
    .where(isNotNull(document.facilityNameRaw));
  return rows
    .filter((row) => row.rawName !== null && facilityFingerprint(row.rawName) === fingerprint)
    .map((row) => row.id);
}

/** AI 提议的执行层。所有 DB 写入都由确定性代码完成。 */
export async function applyFacilityDecision(
  tx: Tx,
  fingerprint: string,
  proposalInput: unknown,
  state: 'proposed' | 'confirmed' | 'rejected',
): Promise<string | null> {
  const proposal = FacilityProposal.parse(proposalInput);
  const documentIds = await matchingDocumentIds(tx, fingerprint);
  if (documentIds.length === 0) return null;

  if (state === 'rejected') {
    await tx.update(document).set({ facilityId: null }).where(inArray(document.id, documentIds));
    return null;
  }

  const proposedFacility = proposal.facility;
  let row = (await tx.select().from(facility).where(eq(facility.slug, proposedFacility.slug)).limit(1))[0];
  if (!row) {
    row = (await tx.insert(facility).values({
      id: uuidv7(), slug: proposedFacility.slug, name: proposedFacility.name,
      aliases: [...new Set(proposal.matched_raw_names)],
      city: proposedFacility.city, level: proposedFacility.level,
    }).returning())[0]!;
  } else {
    const aliases = [...new Set([...row.aliases, ...proposal.matched_raw_names])];
    if (aliases.length !== row.aliases.length) {
      row = (await tx.update(facility).set({ aliases }).where(eq(facility.id, row.id)).returning())[0]!;
    }
  }

  // §2.2 明确要求批量回填**全部**同指纹且尚未归一的文档。
  await tx.update(document).set({ facilityId: row.id }).where(and(
    inArray(document.id, documentIds),
    isNull(document.facilityId),
  ));
  const people = await tx.select({ personId: document.personId }).from(document)
    .where(inArray(document.id, documentIds));
  for (const personId of new Set(people.map((item) => item.personId))) {
    await enqueue(tx, {
      kind: 'encounter_suggest', dedupKey: dedupKey.encounterSuggest(personId),
      documentId: null, personId,
    });
  }
  return row.id;
}

/** Stage 1 事务内调用：命中缓存就直接执行，未命中才投递家庭级作业。 */
export async function scheduleFacilityNormalization(tx: Tx, rawName: string): Promise<void> {
  const fingerprint = facilityFingerprint(rawName);
  const cached = (await tx.select().from(normalizationDecision)
    .where(and(eq(normalizationDecision.kind, 'facility'), eq(normalizationDecision.inputFingerprint, fingerprint)))
    .limit(1))[0];
  if (cached) {
    await applyFacilityDecision(tx, fingerprint, cached.proposal, cached.state as 'proposed' | 'confirmed' | 'rejected');
    return;
  }
  await enqueue(tx, {
    kind: 'facility_normalize', dedupKey: dedupKey.facilityNormalize(fingerprint),
    documentId: null, personId: null,
  });
}

export async function handleFacilityNormalize(dedup: string): Promise<{ decisionId: string }> {
  const fingerprint = fingerprintFromFacilityDedup(dedup);
  const existingDecision = (await db.select().from(normalizationDecision)
    .where(and(eq(normalizationDecision.kind, 'facility'), eq(normalizationDecision.inputFingerprint, fingerprint)))
    .limit(1))[0];
  if (existingDecision) {
    await db.transaction((tx) => applyFacilityDecision(
      tx, fingerprint, existingDecision.proposal,
      existingDecision.state as 'proposed' | 'confirmed' | 'rejected',
    ));
    return { decisionId: existingDecision.id };
  }

  const rawNames = await db.transaction((tx) => matchingRawNames(tx, fingerprint));
  const rawName = rawNames[0];
  if (!rawName) {
    throw new FacilityJobFailure('failed', {
      stage: 'facility', code: 'raw_name_not_found', message: '找不到与 facility 指纹匹配的机构原文',
    });
  }
  const existing = (await db.select().from(facility)).map((row) => ({
    slug: row.slug, name: row.name, aliases: row.aliases, city: row.city, level: row.level,
  }));

  let result: Awaited<ReturnType<typeof callFacilityNormalization>>;
  try {
    result = await callFacilityNormalization(rawName, existing);
  } catch (error) {
    if (error instanceof FacilityNormalizationError) {
      throw new FacilityJobFailure('needs_human', {
        stage: 'facility', code: error.kind, message: error.message,
      });
    }
    throw error;
  }
  const proposal = finalFacilityProposal(result.output, existing, rawNames);

  return db.transaction(async (tx) => {
    const inserted = await tx.insert(normalizationDecision).values({
      id: uuidv7(), kind: 'facility', inputFingerprint: fingerprint,
      proposal, state: 'proposed', promptId: result.promptId,
      promptVersion: result.promptVersion, model: result.model,
    }).onConflictDoNothing({ target: normalizationDecision.inputFingerprint }).returning({ id: normalizationDecision.id });
    const chosen = inserted[0] ?? (await tx.select({ id: normalizationDecision.id })
      .from(normalizationDecision).where(eq(normalizationDecision.inputFingerprint, fingerprint)).limit(1))[0];
    if (!chosen) throw new Error('归一决策并发落库失败');
    const decision = (await tx.select().from(normalizationDecision)
      .where(eq(normalizationDecision.id, chosen.id)).limit(1))[0]!;
    await applyFacilityDecision(tx, fingerprint, decision.proposal, decision.state as 'proposed' | 'confirmed' | 'rejected');
    return { decisionId: chosen.id };
  });
}
