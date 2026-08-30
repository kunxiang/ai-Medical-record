import { and, eq, ilike, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  DocumentMetadataMutationResponse, DocumentMetadataPatch,
  FacilityListQuery, FacilityListResponse, Uuid,
} from '@amr/contracts';
import { requireDocumentAccess } from '../access.js';
import { db } from '../db/client.js';
import { document, documentManualMetadata, facility, personAccess } from '../db/schema.js';
import { defineRoute } from '../define-route.js';
import { patchDocumentMetadata } from '../services/metadata.js';

export function registerMetadataRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'PATCH',
    url: '/api/v1/documents/:id/metadata',
    input: DocumentMetadataPatch.innerType().extend({ id: Uuid }).strict(),
    output: DocumentMetadataMutationResponse,
    handler: async ({ input, accountId }) => {
      await requireDocumentAccess(accountId, input.id, 'editor');
      const { id, ...rawPatch } = input;
      const patch = DocumentMetadataPatch.parse(rawPatch);
      return patchDocumentMetadata({ documentId: id, accountId, patch });
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/facilities',
    input: FacilityListQuery,
    output: FacilityListResponse,
    handler: async ({ input, accountId }) => {
      const conditions = [sql`exists (
        select 1 from ${document}
        inner join ${personAccess} on ${personAccess.personId} = ${document.personId}
        left join ${documentManualMetadata} on ${documentManualMetadata.documentId} = ${document.id}
        where ${personAccess.accountId} = ${accountId}
          and (${document.facilityId} = ${facility.id}
            or ${documentManualMetadata.facilityId} = ${facility.id})
      )`];
      if (input.q) {
        const pattern = `%${input.q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        conditions.push(or(ilike(facility.name, pattern), sql`${pattern} = any(${facility.aliases})`)!);
      }
      const rows = await db.select().from(facility).where(and(...conditions))
        .orderBy(facility.name, facility.id).limit(input.limit);
      return { facilities: rows };
    },
  });
}
