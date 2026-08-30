import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ExportJob, ExportListQuery, ExportListResponse, ExportPreviewRequest, ExportPreviewResponse,
  ExportRetryRequest, PersonBundleRequest, Uuid, VisitSummaryCreateRequest,
} from '@amr/contracts';
import { requirePersonAccess, requirePersonRole } from '../access.js';
import { defineRoute } from '../define-route.js';
import { ApiError, notFound } from '../errors.js';
import { getObjectStream } from '../s3.js';
import { createPersonBundle } from '../exports/person-bundle.js';
import { buildExportPreview } from '../exports/canonical-input.js';
import {
  createVisitSummaryJob, exportJobOut, getExportRow, listExports, retryExportJob,
} from '../exports/jobs.js';

export function registerExportRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'POST', url: '/api/v1/exports/preview',
    input: ExportPreviewRequest, output: ExportPreviewResponse,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'editor');
      return buildExportPreview(input);
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/exports/visit-summary', status: 201,
    input: VisitSummaryCreateRequest, output: ExportJob,
    handler: async ({ input, accountId }) => {
      await requirePersonAccess(accountId, input.person_id, 'editor');
      return createVisitSummaryJob({ accountId, body: input });
    },
  });
  defineRoute(app, {
    method: 'GET', url: '/api/v1/people/:person_id/exports',
    input: ExportListQuery, output: ExportListResponse,
    handler: async ({ input, accountId }) => {
      const role = await requirePersonRole(accountId, input.person_id, 'viewer');
      return listExports(input, role);
    },
  });
  defineRoute(app, {
    method: 'GET', url: '/api/v1/exports/:id',
    input: z.object({ id: Uuid }).strict(), output: ExportJob,
    handler: async ({ input, accountId }) => {
      const row = await getExportRow(input.id);
      const role = await requirePersonRole(accountId, row.personId, 'viewer');
      if (role === 'viewer' && row.state !== 'done') throw notFound();
      return exportJobOut(row);
    },
  });
  defineRoute(app, {
    method: 'POST', url: '/api/v1/exports/:id/retry',
    input: ExportRetryRequest.extend({ id: Uuid }).strict(), output: ExportJob,
    handler: async ({ input, accountId }) => {
      const row = await getExportRow(input.id);
      await requirePersonAccess(accountId, row.personId, 'editor');
      return retryExportJob({
        jobId: row.id, accountId, clientOperationId: input.client_operation_id,
      });
    },
  });
  defineRoute(app, {
    method: 'GET', url: '/api/v1/exports/:id/download',
    input: z.object({ id: Uuid }).strict(), output: z.unknown(),
    handler: async ({ input, accountId, reply }) => {
      const row = await getExportRow(input.id);
      await requirePersonAccess(accountId, row.personId, 'viewer');
      if (row.state !== 'done' || !row.resultKey) throw notFound();
      const stream = await getObjectStream(row.resultKey);
      if (!stream) throw new ApiError('export_artifact_missing', '导出文件对象已丢失，可以按原请求重新生成');
      const format = (row.request as { format?: string }).format === 'png' ? 'png' : 'pdf';
      return reply.header('content-type', format === 'png' ? 'image/png' : 'application/pdf')
        .header('content-disposition', `attachment; filename="medireco-visit-summary.${format}"`)
        .header('cache-control', 'private, no-store').send(stream);
    },
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/exports/person-bundle',
    input: PersonBundleRequest,
    output: z.unknown(),
    handler: async ({ input, accountId, reply }) => {
      await requirePersonAccess(accountId, input.person_id, 'viewer');
      const bundle = await createPersonBundle(input.person_id);
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${bundle.filename}"`)
        .header('cache-control', 'private, no-store')
        .send(bundle.stream);
    },
  });
}
