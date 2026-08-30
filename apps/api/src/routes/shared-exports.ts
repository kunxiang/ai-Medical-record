import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ExportShare, ExportShareCreateRequest, ExportShareCreateResponse,
  ExportShareListResponse, ExportShareRevokeRequest, PublicExportShareRequest, Uuid,
} from '@amr/contracts';
import { requirePersonAccess } from '../access.js';
import { defineRoute } from '../define-route.js';
import { getExportRow } from '../exports/jobs.js';
import {
  createExportShare, listExportShares, openPublicExportShare, revokeExportShare,
} from '../services/export-shares.js';

export function registerExportShareRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'POST', url: '/api/v1/exports/:id/shares', status: 201,
    input: ExportShareCreateRequest.extend({ id: Uuid }).strict(),
    output: ExportShareCreateResponse,
    handler: async ({ input, accountId }) => {
      const job = await getExportRow(input.id);
      await requirePersonAccess(accountId, job.personId, 'owner');
      return createExportShare({ exportJobId: job.id, accountId, body: input });
    },
  });
  defineRoute(app, {
    method: 'GET', url: '/api/v1/exports/:id/shares',
    input: z.object({ id: Uuid }).strict(), output: ExportShareListResponse,
    handler: async ({ input, accountId }) => {
      const job = await getExportRow(input.id);
      await requirePersonAccess(accountId, job.personId, 'owner');
      return listExportShares(job.id);
    },
  });
  defineRoute(app, {
    method: 'DELETE', url: '/api/v1/exports/:id/shares/:share_id',
    input: ExportShareRevokeRequest.extend({ id: Uuid, share_id: Uuid }).strict(),
    output: ExportShare,
    handler: async ({ input, accountId }) => {
      const job = await getExportRow(input.id);
      await requirePersonAccess(accountId, job.personId, 'owner');
      return revokeExportShare({
        exportJobId: job.id, shareId: input.share_id, accountId,
        clientOperationId: input.client_operation_id,
      });
    },
  });
  defineRoute(app, {
    method: 'GET', url: '/api/v1/shared/exports/:token', auth: 'none',
    input: PublicExportShareRequest, output: z.unknown(),
    handler: async ({ input, req, reply }) => {
      reply.header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer');
      try {
        const opened = await openPublicExportShare({ token: input.token, ip: req.ip });
        req.log.info({ share_id: opened.shareId, result: 'served' }, 'shared export access');
        return reply
          .header('content-type', opened.format === 'png' ? 'image/png' : 'application/pdf')
          .header('content-disposition', `inline; filename="medireco-shared-summary.${opened.format}"`)
          .send(opened.stream);
      } catch (error) {
        req.log.info({ share_id: null, result: 'unavailable' }, 'shared export access');
        throw error;
      }
    },
  });
}
