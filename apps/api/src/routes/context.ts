import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ContextAnswersUpsertRequest, ContextPendingQuery, ContextPendingResponse,
  ContextAnswerPromoteRequest, ContextAnswerPromoteResponse,
  ContextSessionBindRequest, ContextSessionCompleteRequest, ContextSessionCreate,
  ContextSessionDetailResponse, ContextSessionMutationResponse,
  ContextTemplateManifestResponse, ContextTemplateSnapshot, Uuid,
  ContextUploadFinalizeRequest, ContextUploadFinalizeResponse,
  ContextUploadPrepareRequest, ContextUploadPrepareResponse,
  ContextUploadPresignResponse, ContextUploadViewResponse,
} from '@amr/contracts';
import { contextTemplateManifest, getContextTemplate } from '@amr/medical';
import { requirePersonAccess } from '../access.js';
import { db } from '../db/client.js';
import { contextSession } from '../db/schema.js';
import { defineRoute } from '../define-route.js';
import { ApiError, notFound } from '../errors.js';
import {
  bindContextDocument, completeContextSession, createContextSession,
  getContextSessionDetail, listPendingContext, upsertContextAnswers,
} from '../services/context.js';
import {
  contextUploadPersonId, finalizeContextUpload, prepareContextUpload,
  presignContextUpload, viewContextUpload,
} from '../services/context-upload.js';
import {
  contextAnswerPersonId, promoteContextAnswer,
} from '../services/context-promotions.js';

const ContextAnswersRouteInput = ContextAnswersUpsertRequest.innerType()
  .extend({ id: Uuid }).strict().superRefine((request, ctx) => {
    if (new Set(request.answers.map((answer) => answer.question_key)).size !== request.answers.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers'], message: '同一批次的 question_key 不得重复' });
    }
  });

const ContextPromoteRouteInput = z.object({
  id: Uuid,
  client_operation_id: Uuid,
  confirmed: z.boolean(),
  target_type: z.enum(['medication', 'observation']),
  draft: z.unknown(),
  defaults: z.unknown().optional(),
}).passthrough();

async function requireContextSessionAccess(
  accountId: string,
  sessionId: string,
  role: 'viewer' | 'editor',
): Promise<void> {
  const row = (await db.select({ personId: contextSession.personId }).from(contextSession)
    .where(eq(contextSession.id, sessionId)).limit(1))[0];
  if (!row) throw notFound();
  await requirePersonAccess(accountId, row.personId, role);
}

export function registerContextRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET', url: '/api/v1/context/templates',
    input: z.object({}).strict(), output: ContextTemplateManifestResponse,
    handler: async () => contextTemplateManifest(),
  });
  defineRoute(app, {
    method: 'GET', url: '/api/v1/context/templates/:template_id/versions/:version',
    input: z.object({
      template_id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
      version: z.coerce.number().int().min(1),
    }).strict(),
    output: ContextTemplateSnapshot,
    handler: async ({ input }) => {
      const template = getContextTemplate(input.template_id, input.version);
      if (!template) throw notFound();
      return template;
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/context/sessions', status: 201,
    input: ContextSessionCreate, output: ContextSessionMutationResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'editor');
      return createContextSession({ accountId, body: input });
    },
  });
  defineRoute(app, {
    method: 'GET', url: '/api/v1/context/sessions/:id',
    input: z.object({ id: Uuid }).strict(), output: ContextSessionDetailResponse,
    handler: async ({ input, accountId }) => {
      await requireContextSessionAccess(accountId, input.id, 'viewer');
      return getContextSessionDetail(input.id);
    },
  });
  defineRoute(app, {
    method: 'GET', url: '/api/v1/context/pending',
    input: ContextPendingQuery, output: ContextPendingResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'viewer');
      return listPendingContext({
        accountId, personId: input.person_id, localDate: input.local_date,
        cursor: input.cursor, limit: input.limit,
      });
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/context/sessions/:id/bind-document',
    input: ContextSessionBindRequest.extend({ id: Uuid }).strict(), output: ContextSessionMutationResponse,
    handler: async ({ input, accountId }) => {
      await requireContextSessionAccess(accountId, input.id, 'editor');
      const { id, ...body } = input;
      return bindContextDocument({ sessionId: id, accountId, body });
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/context/sessions/:id/answers',
    input: ContextAnswersRouteInput, output: ContextSessionMutationResponse,
    handler: async ({ input, accountId }) => {
      await requireContextSessionAccess(accountId, input.id, 'editor');
      const { id, ...body } = input;
      return upsertContextAnswers({ sessionId: id, accountId, body });
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/context/answers/:id/promote',
    input: ContextPromoteRouteInput, output: ContextAnswerPromoteResponse,
    handler: async ({ input, accountId }) => {
      const personId = await contextAnswerPersonId(input.id);
      await requirePersonAccess(accountId, personId, 'editor');
      const { id, ...raw } = input;
      const parsed = ContextAnswerPromoteRequest.safeParse(raw);
      if (!parsed.success) {
        throw new ApiError('validation_failed', '入参校验失败', { issues: parsed.error.issues });
      }
      return promoteContextAnswer({ answerId: id, accountId, body: parsed.data });
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/context/sessions/:id/complete',
    input: ContextSessionCompleteRequest.extend({ id: Uuid }).strict(), output: ContextSessionMutationResponse,
    handler: async ({ input, accountId }) => {
      await requireContextSessionAccess(accountId, input.id, 'editor');
      const { id, ...body } = input;
      return completeContextSession({ sessionId: id, accountId, body });
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/context/uploads/prepare', status: 201,
    input: ContextUploadPrepareRequest, output: ContextUploadPrepareResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'editor');
      return prepareContextUpload({ accountId, body: input });
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/context/uploads/:upload_id/presign',
    input: z.object({ upload_id: Uuid }).strict(), output: ContextUploadPresignResponse,
    handler: async ({ input, accountId }) => {
      const personId = await contextUploadPersonId(input.upload_id);
      await requirePersonAccess(accountId, personId, 'editor');
      return presignContextUpload(input.upload_id, accountId);
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/context/uploads/:upload_id/finalize',
    input: ContextUploadFinalizeRequest.extend({ upload_id: Uuid }).strict(),
    output: ContextUploadFinalizeResponse,
    handler: async ({ input, accountId }) => {
      const personId = await contextUploadPersonId(input.upload_id);
      await requirePersonAccess(accountId, personId, 'editor');
      const { upload_id, ...body } = input;
      return finalizeContextUpload({ uploadId: upload_id, accountId, body });
    },
  });
  defineRoute(app, {
    method: 'GET', url: '/api/v1/context/uploads/:upload_id',
    input: z.object({ upload_id: Uuid }).strict(), output: ContextUploadViewResponse,
    handler: async ({ input, accountId }) => {
      const personId = await contextUploadPersonId(input.upload_id);
      await requirePersonAccess(accountId, personId, 'viewer');
      return viewContextUpload(input.upload_id);
    },
  });
}
