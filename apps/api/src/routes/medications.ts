import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  Medication, MedicationArchiveRequest, MedicationBatchCreateRequest,
  MedicationBatchCreateResponse, MedicationListQuery, MedicationListResponse,
  MedicationPatchRequest, Uuid,
} from '@amr/contracts';
import { requirePersonAccess } from '../access.js';
import { db } from '../db/client.js';
import { medication } from '../db/schema.js';
import { defineRoute } from '../define-route.js';
import { notFound } from '../errors.js';
import {
  archiveMedication, createMedicationBatch, listMedications, patchMedication,
} from '../services/medications.js';

async function requireMedicationAccess(
  accountId: string, medicationId: string, role: 'viewer' | 'editor',
): Promise<void> {
  const row = (await db.select({ personId: medication.personId }).from(medication)
    .where(eq(medication.id, medicationId)).limit(1))[0];
  if (!row) throw notFound();
  await requirePersonAccess(accountId, row.personId, role);
}

export function registerMedicationRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET', url: '/api/v1/people/:person_id/medications',
    input: MedicationListQuery, output: MedicationListResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'viewer');
      return MedicationListResponse.parse(await listMedications(input));
    },
  });
  defineRoute(app, {
    // find-my-way 用双冒号注册字面 ':'；对外仍是 .../medications:batch。
    method: 'POST', url: '/api/v1/people/:person_id/medications::batch', status: 201,
    input: MedicationBatchCreateRequest.innerType().extend({ person_id: Uuid }).strict(),
    output: MedicationBatchCreateResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'editor');
      const { person_id, ...body } = input;
      return createMedicationBatch({
        personId: person_id, accountId, body: MedicationBatchCreateRequest.parse(body),
      });
    },
  });
  defineRoute(app, {
    method: 'PATCH', url: '/api/v1/medications/:id',
    input: MedicationPatchRequest.innerType().extend({ id: Uuid }).strict(), output: Medication,
    handler: async ({ input, accountId }) => {
      await requireMedicationAccess(accountId, input.id, 'editor');
      const { id, ...body } = input;
      return patchMedication({
        medicationId: id, accountId, body: MedicationPatchRequest.parse(body),
      });
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/medications/:id/archive',
    input: MedicationArchiveRequest.extend({ id: Uuid }).strict(), output: Medication,
    handler: async ({ input, accountId }) => {
      await requireMedicationAccess(accountId, input.id, 'editor');
      const { id, ...body } = input;
      return archiveMedication({ medicationId: id, accountId, body });
    },
  });
}
