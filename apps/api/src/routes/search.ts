import type { FastifyInstance } from 'fastify';
import { SearchQuery, SearchResponse } from '@amr/contracts';
import { requirePersonAccess } from '../access.js';
import { defineRoute } from '../define-route.js';
import { searchCore } from '../services/search.js';

export function registerSearchRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/search',
    input: SearchQuery,
    output: SearchResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'viewer');
      return searchCore(input);
    },
  });
}
