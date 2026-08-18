import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { PersonSidecar, type PersonSidecarT } from '@amr/contracts';
import { buildKey, canonicalJson, serverTimestamp } from '@amr/storage';
import { db, type Tx } from './db/client.js';
import { person, personIdentifier } from './db/schema.js';
import { appendJournal } from './journal.js';
import { putRewritable } from './s3.js';

/** 从 DB 读出 person 全量快照(含 identifiers),供 sidecar 与 journal 共用。 */
export async function loadPersonSidecar(tx: Tx, personId: string): Promise<PersonSidecarT> {
  const rows = await tx.select().from(person).where(eq(person.id, personId)).limit(1);
  const p = rows[0];
  if (!p) throw new Error(`person 不存在: ${personId}`);
  const ids = await tx.select().from(personIdentifier).where(eq(personIdentifier.personId, personId));
  return PersonSidecar.parse({
    schema_version: '1.0',
    id: p.id,
    slug: p.slug,
    display_name: p.displayName,
    name_pinyin: p.namePinyin,
    birth_date: p.birthDate,
    sex_at_birth: p.sexAtBirth,
    gender: p.gender,
    relation_to_owner: p.relationToOwner,
    blood_type: p.bloodType,
    allergies: p.allergies,
    chronic_conditions: p.chronicConditions,
    note: p.note,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
    archived_at: p.archivedAt?.toISOString() ?? null,
    identifiers: ids.map((i) => ({
      id: i.id,
      facility_id: i.facilityId,
      identifier_type: i.identifierType,
      identifier_value: i.identifierValue,
      scope: i.scope,
    })),
  });
}

/** 全 person 的 slug→姓名 映射(_index/people.json,重写式)。 */
async function rebuildPeopleMap(tx: Tx): Promise<void> {
  const all = await tx.select().from(person);
  const map = {
    schema_version: '1.0',
    updated_at: serverTimestamp(),
    people: all
      .map((p) => ({
        slug: p.slug,
        name: p.displayName,
        birth_date: p.birthDate,
        relation: p.relationToOwner,
        archived: p.archivedAt !== null,
      }))
      .sort((a, b) => (a.slug < b.slug ? -1 : 1)),
  };
  await putRewritable(buildKey.peopleMap(), canonicalJson(map));
}

/** person 级互斥:变更事务必须以此开场 —— 否则并发编辑下 _person.json 的
 *  重写不按提交序落桶,桶内快照停在中间版本(验收 A10/B5 实证,CHANGES #3)。 */
export async function lockPerson(tx: Tx, personId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'person:' + personId}, 0))`);
}

/** spec m0-06 §1:建档/改档/归档的五步原子。
 *  调用方在 db.transaction 内完成第 1 步 DB 写后调用本函数(第 2-4 步),随后事务提交(第 5 步)。 */
export async function syncPersonToS3(tx: Tx, personId: string, byAccountId: string): Promise<PersonSidecarT> {
  const sidecar = await loadPersonSidecar(tx, personId);
  await putRewritable(buildKey.person({ personSlug: sidecar.slug }), canonicalJson(sidecar)); // 步骤 2
  await rebuildPeopleMap(tx); // 步骤 3
  await appendJournal(tx, sidecar.slug, {
    schema_version: '1.0',
    event: 'person_update',
    by_account_id: byAccountId,
    person: sidecar,
  }); // 步骤 4
  return sidecar;
}

export function newId(): string {
  return uuidv7();
}

export function personToApi(sidecar: PersonSidecarT): Record<string, unknown> {
  const { schema_version: _v, identifiers: _ids, ...rest } = sidecar;
  return rest;
}
