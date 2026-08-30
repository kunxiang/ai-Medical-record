import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { FacilityProposal } from '@amr/contracts';
import type { Tx } from '../db/client.js';
import { document, facility } from '../db/schema.js';
import { scheduleEncounterSuggestion } from '../processing/scheduling.js';
import { facilityFingerprint } from './facility-fingerprint.js';

async function matchingDocumentIds(tx: Tx, fingerprint: string): Promise<string[]> {
  const rows = await tx.select({ id: document.id, rawName: document.facilityNameRaw })
    .from(document).where(isNotNull(document.facilityNameRaw));
  return rows.filter((row) => row.rawName !== null && facilityFingerprint(row.rawName) === fingerprint)
    .map((row) => row.id);
}

/** 人工接受/拒绝后的确定性执行层；Core route 可以安全导入，不依赖 provider SDK。 */
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

  const proposed = proposal.facility;
  let row = (await tx.select().from(facility).where(eq(facility.slug, proposed.slug)).limit(1))[0];
  if (!row) {
    row = (await tx.insert(facility).values({
      id: uuidv7(), slug: proposed.slug, name: proposed.name,
      aliases: [...new Set(proposal.matched_raw_names)],
      city: proposed.city, level: proposed.level,
    }).returning())[0]!;
  } else {
    const aliases = [...new Set([...row.aliases, ...proposal.matched_raw_names])];
    if (aliases.length !== row.aliases.length) {
      row = (await tx.update(facility).set({ aliases }).where(eq(facility.id, row.id)).returning())[0]!;
    }
  }

  await tx.update(document).set({ facilityId: row.id }).where(and(
    inArray(document.id, documentIds), isNull(document.facilityId),
  ));
  const people = await tx.select({ personId: document.personId }).from(document)
    .where(inArray(document.id, documentIds));
  for (const personId of new Set(people.map((item) => item.personId))) {
    await scheduleEncounterSuggestion(tx, personId);
  }
  return row.id;
}
