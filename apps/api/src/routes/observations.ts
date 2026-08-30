import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  ConceptAliasDecision, ConceptAliasPatchRequest, ConceptAliasUpsertRequest,
  MedicalConceptListResponse, MedicalConceptQuery, Observation,
  ObservationArchiveRequest, ObservationBatchCreateRequest, ObservationBatchCreateResponse,
  ObservationListQuery, ObservationListResponse, ObservationMappingInboxQuery,
  ObservationMappingInboxResponse, ObservationMappingResolveRequest,
  ObservationMappingResolveResponse, ObservationPatchRequest, Uuid,
} from '@amr/contracts';
import { CONCEPT_CATALOG_VERSION, searchConcepts } from '@amr/medical';
import { requirePersonAccess } from '../access.js';
import { defineRoute } from '../define-route.js';
import { ApiError } from '../errors.js';
import {
  archiveObservation, createObservationBatch, listObservations, observationPersonId,
  patchObservation,
} from '../services/observations.js';
import {
  conceptAliasPersonId, listObservationMappingInbox, patchConceptAlias,
  resolveObservationMapping, upsertConceptAlias,
} from '../services/observation-mapping.js';

function validateBody<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError('validation_failed', '入参校验失败', { issues: parsed.error.issues });
  }
  return parsed.data;
}

export function registerObservationRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET', url: '/api/v1/medical/concepts',
    input: MedicalConceptQuery, output: MedicalConceptListResponse,
    handler: async ({ input }) => ({
      concepts: searchConcepts(input.q, { kind: input.kind, limit: input.limit }).map((concept) => ({
        ...concept, aliases: [...concept.aliases], catalog_version: CONCEPT_CATALOG_VERSION,
      })),
    }),
  });

  defineRoute(app, {
    method: 'GET', url: '/api/v1/people/:person_id/observation-mapping-inbox',
    input: ObservationMappingInboxQuery, output: ObservationMappingInboxResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'viewer');
      return listObservationMappingInbox({
        personId: input.person_id, cursor: input.cursor, limit: input.limit,
      });
    },
  });

  defineRoute(app, {
    method: 'POST', url: '/api/v1/people/:person_id/concept-aliases', status: 201,
    input: ConceptAliasUpsertRequest.extend({ person_id: Uuid }).strict(),
    output: ConceptAliasDecision,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'editor');
      const { person_id: personId, ...raw } = input;
      return upsertConceptAlias({ personId, accountId, body: ConceptAliasUpsertRequest.parse(raw) });
    },
  });

  defineRoute(app, {
    method: 'PATCH', url: '/api/v1/concept-aliases/:id',
    input: ConceptAliasPatchRequest.extend({ id: Uuid }).strict(), output: ConceptAliasDecision,
    handler: async ({ input, accountId }) => {
      const personId = await conceptAliasPersonId(input.id);
      await requirePersonAccess(accountId, personId, 'editor');
      const { id, ...raw } = input;
      return patchConceptAlias({ aliasId: id, accountId, body: ConceptAliasPatchRequest.parse(raw) });
    },
  });

  defineRoute(app, {
    // find-my-way 用双冒号注册字面 ':'；对外契约仍是 ...inbox:resolve。
    method: 'POST', url: '/api/v1/people/:person_id/observation-mapping-inbox::resolve',
    input: ObservationMappingResolveRequest.extend({ person_id: Uuid }).strict(),
    output: ObservationMappingResolveResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'editor');
      const { person_id: personId, ...raw } = input;
      return resolveObservationMapping({
        personId, accountId, body: ObservationMappingResolveRequest.parse(raw),
      });
    },
  });

  defineRoute(app, {
    method: 'GET', url: '/api/v1/people/:person_id/observations',
    input: ObservationListQuery, output: ObservationListResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'viewer');
      return listObservations(input);
    },
  });

  defineRoute(app, {
    // find-my-way 用双冒号注册字面 ':'；对外契约仍是 ...observations:batch。
    method: 'POST', url: '/api/v1/people/:person_id/observations::batch', status: 201,
    input: ObservationBatchCreateRequest.innerType().extend({ person_id: Uuid }).strict(),
    output: ObservationBatchCreateResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'editor');
      const { person_id: personId, ...raw } = input;
      const body = validateBody(ObservationBatchCreateRequest, raw);
      return createObservationBatch({ personId, accountId, body });
    },
  });

  defineRoute(app, {
    method: 'PATCH', url: '/api/v1/observations/:id',
    input: ObservationPatchRequest.innerType().extend({ id: Uuid }).strict(),
    output: Observation,
    handler: async ({ input, accountId }) => {
      const personId = await observationPersonId(input.id);
      await requirePersonAccess(accountId, personId, 'editor');
      const { id, ...raw } = input;
      return patchObservation({
        observationId: id, accountId, body: validateBody(ObservationPatchRequest, raw),
      });
    },
  });

  defineRoute(app, {
    method: 'POST', url: '/api/v1/observations/:id/archive',
    input: ObservationArchiveRequest.extend({ id: Uuid }).strict(),
    output: Observation,
    handler: async ({ input, accountId }) => {
      const personId = await observationPersonId(input.id);
      await requirePersonAccess(accountId, personId, 'editor');
      const { id, ...raw } = input;
      return archiveObservation({ observationId: id, accountId, body: ObservationArchiveRequest.parse(raw) });
    },
  });
}
