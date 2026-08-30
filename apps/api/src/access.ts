import { and, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { AccessRole } from '@amr/contracts';
import { db } from './db/client.js';
import { document, person, personAccess } from './db/schema.js';
import { notFound } from './errors.js';

type Role = z.infer<typeof AccessRole>;
const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

/** spec m0-05 §3:唯二检查点之一。无行/角色不足/已归档 → 一律 404,不可区分。 */
export async function requirePersonAccess(accountId: string, personId: string, minRole: Role): Promise<void> {
  await requirePersonRole(accountId, personId, minRole);
}

export async function requirePersonRole(accountId: string, personId: string, minRole: Role): Promise<Role> {
  const rows = await db
    .select({ role: personAccess.role, archivedAt: person.archivedAt })
    .from(personAccess)
    .innerJoin(person, eq(person.id, personAccess.personId))
    .where(and(eq(personAccess.accountId, accountId), eq(personAccess.personId, personId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound();
  if (RANK[row.role as Role] < RANK[minRole]) throw notFound();
  if (row.archivedAt !== null) throw notFound();
  return row.role as Role;
}

/** 唯二检查点之二(审核 #001 #11):document 定位 → 同一核心。 */
export async function requireDocumentAccess(
  accountId: string,
  documentId: string,
  minRole: Role,
): Promise<{ personId: string }> {
  const rows = await db
    .select({ personId: document.personId })
    .from(document)
    .where(eq(document.id, documentId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound();
  await requirePersonAccess(accountId, row.personId, minRole);
  return { personId: row.personId };
}
