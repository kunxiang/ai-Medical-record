import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  TimelineEvent, TimelineEventArchiveRequest, TimelineEventCreateRequest,
  TimelineEventListQuery, TimelineEventListResponse, TimelineEventPatchRequest, Uuid,
} from '@amr/contracts';
import { requirePersonAccess } from '../access.js';
import { db } from '../db/client.js';
import { timelineEvent } from '../db/schema.js';
import { defineRoute } from '../define-route.js';
import { ApiError, notFound } from '../errors.js';
import {
  archiveTimelineEvent, createTimelineEvent, listTimelineEvents, patchTimelineEvent,
} from '../services/timeline-events.js';

function validateBody<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError('validation_failed', '入参校验失败', { issues: parsed.error.issues });
  }
  return parsed.data;
}

async function requireTimelineEventAccess(
  accountId: string, eventId: string, role: 'viewer' | 'editor',
): Promise<void> {
  const row = (await db.select({ personId: timelineEvent.personId }).from(timelineEvent)
    .where(eq(timelineEvent.id, eventId)).limit(1))[0];
  if (!row) throw notFound();
  await requirePersonAccess(accountId, row.personId, role);
}

export function registerTimelineEventRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET', url: '/api/v1/people/:person_id/timeline-events',
    input: TimelineEventListQuery, output: TimelineEventListResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'viewer');
      return TimelineEventListResponse.parse(await listTimelineEvents(input));
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/people/:person_id/timeline-events', status: 201,
    input: TimelineEventCreateRequest.innerType().extend({ person_id: Uuid }).strict(),
    output: TimelineEvent,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'editor');
      const { person_id, ...body } = input;
      return createTimelineEvent({
        personId: person_id, accountId, body: validateBody(TimelineEventCreateRequest, body),
      });
    },
  });
  defineRoute(app, {
    method: 'PATCH', url: '/api/v1/timeline-events/:id',
    input: TimelineEventPatchRequest.innerType().extend({ id: Uuid }).strict(), output: TimelineEvent,
    handler: async ({ input, accountId }) => {
      await requireTimelineEventAccess(accountId, input.id, 'editor');
      const { id, ...body } = input;
      return patchTimelineEvent({
        eventId: id, accountId, body: validateBody(TimelineEventPatchRequest, body),
      });
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/timeline-events/:id/archive',
    input: TimelineEventArchiveRequest.extend({ id: Uuid }).strict(), output: TimelineEvent,
    handler: async ({ input, accountId }) => {
      await requireTimelineEventAccess(accountId, input.id, 'editor');
      const { id, ...body } = input;
      return archiveTimelineEvent({ eventId: id, accountId, body });
    },
  });
}
