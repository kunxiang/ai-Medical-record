import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  Person, PersonCreate, PersonIdentifier, PersonIdentifierCreate, PersonListResponse,
  PersonUpdate, Uuid,
} from '@amr/contracts';
import { newPersonSlug } from '@amr/storage';
import { requirePersonAccess } from '../access.js';
import { db } from '../db/client.js';
import { person, personAccess, personIdentifier } from '../db/schema.js';
import { defineRoute } from '../define-route.js';
import { ApiError, notFound } from '../errors.js';
import { createOwnedPerson, lockPerson, newId, personToApi, syncPersonToS3 } from '../person-service.js';

const PATCH_KEY_TO_COL = {
  display_name: 'displayName',
  name_pinyin: 'namePinyin',
  birth_date: 'birthDate',
  sex_at_birth: 'sexAtBirth',
  gender: 'gender',
  relation_to_owner: 'relationToOwner',
  blood_type: 'bloodType',
  allergies: 'allergies',
  chronic_conditions: 'chronicConditions',
  note: 'note',
} as const;

export function registerPeopleRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/people',
    input: PersonCreate,
    output: Person,
    status: 201,
    handler: async ({ input, accountId }) => {
      // spec m0-06 §1 五步原子;slug 撞 UNIQUE 重试 ≤5(spec m0-03 §1)
      for (let attempt = 0; ; attempt++) {
        const slug = newPersonSlug();
        try {
          const sidecar = await db.transaction((tx) => createOwnedPerson(tx, input, accountId, slug));
          return personToApi(sidecar);
        } catch (e) {
          const msg = e instanceof Error ? e.message : '';
          if (attempt < 5 && msg.includes('person_slug')) continue;
          throw e;
        }
      }
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/people',
    input: z.object({}),
    output: PersonListResponse,
    handler: async ({ accountId }) => {
      // M0 不分页,created_at 升序(spec m0-01 §4 偏差标注)
      const rows = await db
        .select({ p: person })
        .from(person)
        .innerJoin(personAccess, eq(personAccess.personId, person.id))
        .where(and(eq(personAccess.accountId, accountId), isNull(person.archivedAt)))
        .orderBy(asc(person.createdAt));
      return {
        people: rows.map(({ p }) => ({
          id: p.id, slug: p.slug, display_name: p.displayName, name_pinyin: p.namePinyin,
          birth_date: p.birthDate, sex_at_birth: p.sexAtBirth, gender: p.gender,
          relation_to_owner: p.relationToOwner, blood_type: p.bloodType,
          allergies: p.allergies, chronic_conditions: p.chronicConditions, note: p.note,
          created_at: p.createdAt.toISOString(), updated_at: p.updatedAt.toISOString(),
          archived_at: null,
        })),
      };
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/people/:id',
    input: z.object({ id: Uuid }),
    output: Person,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.id, 'viewer');
      const sidecar = await db.transaction(async (tx) => {
        const { loadPersonSidecar } = await import('../person-service.js');
        return loadPersonSidecar(tx, input.id);
      });
      return personToApi(sidecar);
    },
  });

  defineRoute(app, {
    method: 'PATCH',
    url: '/api/v1/people/:id',
    input: z.object({ id: Uuid }).and(PersonUpdate),
    output: Person,
    handler: async ({ input, accountId }) => {
      const { id, ...patch } = input;
      await requirePersonAccess(accountId, id, 'editor');
      // JSON Merge Patch:仅更新请求中出现的键,逐键 UPDATE,禁止整对象 spread(spec m0-01 §3)
      const sets: Record<string, unknown> = { updatedAt: new Date() };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        const col = PATCH_KEY_TO_COL[k as keyof typeof PATCH_KEY_TO_COL];
        if (col) sets[col] = v;
      }
      const sidecar = await db.transaction(async (tx) => {
        await lockPerson(tx, id);
        await tx.update(person).set(sets).where(eq(person.id, id));
        return syncPersonToS3(tx, id, accountId);
      });
      return personToApi(sidecar);
    },
  });

  defineRoute(app, {
    method: 'DELETE',
    url: '/api/v1/people/:id',
    input: z.object({ id: Uuid }),
    output: z.object({ archived: z.literal(true) }),
    handler: async ({ input, accountId }) => {
      // 归档 = 一次编辑,走完整五步(审核 #001 #16)
      await requirePersonAccess(accountId, input.id, 'owner');
      await db.transaction(async (tx) => {
        await lockPerson(tx, input.id);
        await tx.update(person).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(person.id, input.id));
        await syncPersonToS3(tx, input.id, accountId);
      });
      return { archived: true as const };
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/people/:id/identifiers',
    input: z.object({ id: Uuid }),
    output: z.object({ identifiers: z.array(PersonIdentifier) }),
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.id, 'viewer');
      const rows = await db.select().from(personIdentifier).where(eq(personIdentifier.personId, input.id));
      return {
        identifiers: rows.map((i) => ({
          id: i.id, facility_id: i.facilityId, identifier_type: i.identifierType,
          identifier_value: i.identifierValue, scope: i.scope,
        })),
      };
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/people/:id/identifiers',
    input: z.object({ id: Uuid }).and(PersonIdentifierCreate),
    output: PersonIdentifier,
    status: 201,
    handler: async ({ input, accountId }) => {
      const { id: personId, ...ident } = input;
      await requirePersonAccess(accountId, personId, 'editor');
      const identId = newId();
      await db.transaction(async (tx) => {
        await lockPerson(tx, personId);
        await tx.insert(personIdentifier).values({
          id: identId, personId,
          facilityId: ident.facility_id,
          identifierType: ident.identifier_type,
          identifierValue: ident.identifier_value,
          scope: ident.scope,
        });
        await tx.update(person).set({ updatedAt: new Date() }).where(eq(person.id, personId));
        await syncPersonToS3(tx, personId, accountId);
      });
      return { id: identId, ...ident };
    },
  });

  defineRoute(app, {
    method: 'DELETE',
    url: '/api/v1/people/:id/identifiers/:iid',
    input: z.object({ id: Uuid, iid: Uuid }),
    output: z.object({ deleted: z.literal(true) }),
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.id, 'editor');
      const rows = await db
        .select({ id: personIdentifier.id })
        .from(personIdentifier)
        .where(and(eq(personIdentifier.id, input.iid), eq(personIdentifier.personId, input.id)));
      if (!rows[0]) throw notFound();
      await db.transaction(async (tx) => {
        await lockPerson(tx, input.id);
        await tx.delete(personIdentifier).where(eq(personIdentifier.id, input.iid));
        await tx.update(person).set({ updatedAt: new Date() }).where(eq(person.id, input.id));
        await syncPersonToS3(tx, input.id, accountId);
      });
      return { deleted: true as const };
    },
  });
}
