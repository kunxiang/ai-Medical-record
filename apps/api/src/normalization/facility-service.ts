import { and, eq, isNotNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { callFacilityNormalization, FacilityNormalizationError } from '@amr/ai';
import { db, type Tx } from '../db/client.js';
import { document, facility, normalizationDecision } from '../db/schema.js';
import { scheduleFacilitySuggestion } from '../processing/scheduling.js';
import { applyFacilityDecision } from './facility-decisions.js';
import { facilityFingerprint } from './facility-fingerprint.js';
import {
  FacilityJobFailure, finalFacilityProposal, fingerprintFromFacilityDedup,
} from './facility-planning.js';

export { applyFacilityDecision } from './facility-decisions.js';
export { FacilityJobFailure } from './facility-planning.js';

async function matchingRawNames(tx: Tx, fingerprint: string): Promise<string[]> {
  const rows = await tx.select({ rawName: document.facilityNameRaw })
    .from(document).where(isNotNull(document.facilityNameRaw));
  return [...new Set(rows.map((row) => row.rawName)
    .filter((rawName): rawName is string => rawName !== null && facilityFingerprint(rawName) === fingerprint))];
}

/** Stage 1 事务内调用：命中人工决策直接执行；未命中只投递 provider-neutral job。 */
export async function scheduleFacilityNormalization(tx: Tx, rawName: string): Promise<void> {
  const fingerprint = facilityFingerprint(rawName);
  const cached = (await tx.select().from(normalizationDecision).where(and(
    eq(normalizationDecision.kind, 'facility'),
    eq(normalizationDecision.inputFingerprint, fingerprint),
  )).limit(1))[0];
  if (cached) {
    await applyFacilityDecision(
      tx, fingerprint, cached.proposal,
      cached.state as 'proposed' | 'confirmed' | 'rejected',
    );
    return;
  }
  await scheduleFacilitySuggestion(tx, fingerprint);
}

export async function handleFacilityNormalize(subjectId: string): Promise<{ decisionId: string }> {
  const fingerprint = fingerprintFromFacilityDedup(subjectId);
  const existingDecision = (await db.select().from(normalizationDecision).where(and(
    eq(normalizationDecision.kind, 'facility'),
    eq(normalizationDecision.inputFingerprint, fingerprint),
  )).limit(1))[0];
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
    }).onConflictDoNothing({ target: normalizationDecision.inputFingerprint })
      .returning({ id: normalizationDecision.id });
    const chosen = inserted[0] ?? (await tx.select({ id: normalizationDecision.id })
      .from(normalizationDecision).where(eq(normalizationDecision.inputFingerprint, fingerprint)).limit(1))[0];
    if (!chosen) throw new Error('归一决策并发落库失败');
    const decision = (await tx.select().from(normalizationDecision)
      .where(eq(normalizationDecision.id, chosen.id)).limit(1))[0]!;
    await applyFacilityDecision(
      tx, fingerprint, decision.proposal,
      decision.state as 'proposed' | 'confirmed' | 'rejected',
    );
    return { decisionId: chosen.id };
  });
}
