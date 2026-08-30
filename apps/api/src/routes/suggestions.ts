import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MetadataMigrationBatchAcceptRequest, MetadataMigrationBatchAcceptResponse,
  MetadataMigrationInboxQuery, MetadataMigrationInboxResponse,
  MetadataSuggestionAcceptRequest, MetadataSuggestionAcceptResponse,
  MetadataSuggestionListResponse, ObservationSuggestionAcceptRequest,
  ObservationSuggestionAcceptResponse, ObservationSuggestionListResponse, Uuid,
} from '@amr/contracts';
import { requireDocumentAccess, requirePersonAccess } from '../access.js';
import { defineRoute } from '../define-route.js';
import { ApiError } from '../errors.js';
import {
  acceptMetadataSuggestion, listDocumentMetadataSuggestions, listMetadataMigrationInbox,
} from '../services/suggestions.js';
import {
  acceptObservationSuggestion, listDocumentObservationSuggestions,
} from '../services/observation-suggestions.js';

function validateBody<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError('validation_failed', '入参校验失败', { issues: parsed.error.issues });
  }
  return parsed.data;
}

export function registerSuggestionRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/documents/:id/metadata-suggestions',
    input: z.object({ id: Uuid }).strict(),
    output: MetadataSuggestionListResponse,
    handler: async ({ input, accountId }) => {
      await requireDocumentAccess(accountId, input.id, 'viewer');
      return listDocumentMetadataSuggestions(input.id);
    },
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/documents/:id/observation-suggestions',
    input: z.object({ id: Uuid }).strict(),
    output: ObservationSuggestionListResponse,
    handler: async ({ input, accountId }) => {
      await requireDocumentAccess(accountId, input.id, 'viewer');
      return listDocumentObservationSuggestions(input.id);
    },
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/documents/:id/observation-suggestions/:suggestion_id/accept',
    input: ObservationSuggestionAcceptRequest.innerType()
      .extend({ id: Uuid, suggestion_id: Uuid }).strict(),
    output: ObservationSuggestionAcceptResponse,
    handler: async ({ input, accountId }) => {
      await requireDocumentAccess(accountId, input.id, 'editor');
      const { id, suggestion_id, ...raw } = input;
      return acceptObservationSuggestion({
        documentId: id, suggestionId: suggestion_id, accountId,
        request: validateBody(ObservationSuggestionAcceptRequest, raw),
      });
    },
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/metadata-migration-inbox',
    input: MetadataMigrationInboxQuery,
    output: MetadataMigrationInboxResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'viewer');
      return listMetadataMigrationInbox({
        personId: input.person_id, cursor: input.cursor, limit: input.limit,
      });
    },
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/documents/:id/metadata-suggestions/:suggestion_id/accept',
    input: MetadataSuggestionAcceptRequest.extend({ id: Uuid, suggestion_id: Uuid }).strict(),
    output: MetadataSuggestionAcceptResponse,
    handler: async ({ input, accountId }) => {
      await requireDocumentAccess(accountId, input.id, 'editor');
      const { id, suggestion_id, ...request } = input;
      return acceptMetadataSuggestion({
        documentId: id, suggestionId: suggestion_id, accountId, request,
      });
    },
  });
  defineRoute(app, {
    method: 'POST',
    // find-my-way 以双冒号注册字面 ':'；公网契约仍是 ...inbox:batch-accept。
    url: '/api/v1/metadata-migration-inbox::batch-accept',
    input: MetadataMigrationBatchAcceptRequest,
    output: MetadataMigrationBatchAcceptResponse,
    handler: async ({ input, accountId }) => {
      const results = [];
      for (const item of input.items) {
        try {
          await requireDocumentAccess(accountId, item.document_id, 'editor');
          const result = await acceptMetadataSuggestion({
            documentId: item.document_id,
            suggestionId: item.suggestion_id,
            accountId,
            request: {
              client_operation_id: item.client_operation_id,
              if_revision: item.if_revision,
              fields: item.fields,
              overrides: item.overrides,
            },
          });
          results.push({ document_id: item.document_id, ok: true, result, error: null });
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          results.push({
            document_id: item.document_id, ok: false, result: null,
            error: { code: error.code, message: error.message },
          });
        }
      }
      return { results };
    },
  });
}
