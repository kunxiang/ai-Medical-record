import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  MetricGroup, MetricGroupArchiveRequest, MetricGroupCreateRequest,
  MetricGroupListQuery, MetricGroupListResponse, MetricGroupPatchRequest, Uuid,
  TrendQuery, TrendResponse,
} from '@amr/contracts';
import { requirePersonAccess } from '../access.js';
import { db } from '../db/client.js';
import { metricGroup } from '../db/schema.js';
import { defineRoute } from '../define-route.js';
import { notFound } from '../errors.js';
import {
  archiveMetricGroup, createMetricGroup, listMetricGroups, patchMetricGroup,
} from '../services/metric-groups.js';
import { getMetricGroupTrend } from '../services/trends.js';

async function requireMetricGroupAccess(
  accountId: string, groupId: string, role: 'viewer' | 'editor',
): Promise<void> {
  const row = (await db.select({ personId: metricGroup.personId }).from(metricGroup)
    .where(eq(metricGroup.id, groupId)).limit(1))[0];
  if (!row) throw notFound();
  await requirePersonAccess(accountId, row.personId, role);
}

export function registerMetricGroupRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET', url: '/api/v1/people/:person_id/metric-groups',
    input: MetricGroupListQuery, output: MetricGroupListResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'viewer');
      return listMetricGroups(input.person_id, input.include_archived);
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/people/:person_id/metric-groups', status: 201,
    input: MetricGroupCreateRequest.innerType().extend({ person_id: Uuid }).strict(), output: MetricGroup,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'editor');
      const { person_id, ...rawBody } = input;
      return createMetricGroup({
        personId: person_id, accountId, body: MetricGroupCreateRequest.parse(rawBody),
      });
    },
  });
  defineRoute(app, {
    method: 'PATCH', url: '/api/v1/metric-groups/:id',
    input: MetricGroupPatchRequest.innerType().extend({ id: Uuid }).strict(), output: MetricGroup,
    handler: async ({ input, accountId }) => {
      await requireMetricGroupAccess(accountId, input.id, 'editor');
      const { id, ...rawBody } = input;
      return patchMetricGroup({
        groupId: id, accountId, body: MetricGroupPatchRequest.parse(rawBody),
      });
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/metric-groups/:id/archive',
    input: MetricGroupArchiveRequest.extend({ id: Uuid }).strict(), output: MetricGroup,
    handler: async ({ input, accountId }) => {
      await requireMetricGroupAccess(accountId, input.id, 'editor');
      const { id, ...body } = input;
      return archiveMetricGroup({ groupId: id, accountId, body });
    },
  });
  defineRoute(app, {
    method: 'GET', url: '/api/v1/metric-groups/:id/trend',
    input: TrendQuery, output: TrendResponse,
    handler: async ({ input, accountId }) => {
      await requireMetricGroupAccess(accountId, input.id, 'viewer');
      return getMetricGroupTrend(input);
    },
  });
}
