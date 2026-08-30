import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  Encounter, EncounterCreate, EncounterDocumentsSet, EncounterDocumentsSetResponse,
  EncounterListQuery, EncounterListResponse, EncounterPatch, Uuid,
} from '@amr/contracts';
import { requirePersonAccess } from '../access.js';
import { db } from '../db/client.js';
import { encounter } from '../db/schema.js';
import { defineRoute } from '../define-route.js';
import { notFound } from '../errors.js';
import {
  createEncounter, listEncounters, patchEncounter, setEncounterDocuments,
} from '../services/encounters.js';

async function requireEncounterAccess(accountId: string, encounterId: string, role: 'viewer' | 'editor') {
  const row = (await db.select({ personId: encounter.personId }).from(encounter)
    .where(eq(encounter.id, encounterId)).limit(1))[0];
  if (!row) throw notFound();
  await requirePersonAccess(accountId, row.personId, role);
}

export function registerEncounterRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET', url: '/api/v1/people/:person_id/encounters',
    input: EncounterListQuery, output: EncounterListResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'viewer');
      return listEncounters({
        personId: input.person_id, from: input.from, to: input.to,
        cursor: input.cursor, limit: input.limit,
      });
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/people/:person_id/encounters', status: 201,
    input: EncounterCreate.extend({ person_id: Uuid }).strict(), output: Encounter,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'editor');
      const { person_id, ...body } = input;
      return createEncounter({ personId: person_id, accountId, body });
    },
  });
  defineRoute(app, {
    method: 'PATCH', url: '/api/v1/encounters/:id',
    input: EncounterPatch.extend({ id: Uuid }).strict(), output: Encounter,
    handler: async ({ input, accountId }) => {
      await requireEncounterAccess(accountId, input.id, 'editor');
      const { id, ...body } = input;
      return patchEncounter({ encounterId: id, accountId, body });
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/encounters/:id/documents',
    input: EncounterDocumentsSet.innerType().extend({ id: Uuid }).strict(),
    output: EncounterDocumentsSetResponse,
    handler: async ({ input, accountId }) => {
      await requireEncounterAccess(accountId, input.id, 'editor');
      const { id, ...rawBody } = input;
      const body = EncounterDocumentsSet.parse(rawBody);
      return setEncounterDocuments({ encounterId: id, accountId, body });
    },
  });
}
