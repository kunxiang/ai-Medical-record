import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  EncounterDecisionPayload, EncounterProposal, NormalizationConfirmRequest, NormalizationConfirmResponse,
  NormalizationDecisionListQuery, NormalizationDecisionListResponse,
  Uuid,
} from '@amr/contracts';
import { serverTimestamp } from '@amr/storage';
import { db } from '../db/client.js';
import { document, facility, normalizationDecision, person, personAccess } from '../db/schema.js';
import { defineRoute } from '../define-route.js';
import { ApiError, notFound } from '../errors.js';
import { appendDecision } from '../journal.js';
import { applyFacilityDecision } from '../normalization/facility-service.js';
import { facilityFingerprint } from '../normalization/facility-fingerprint.js';
import { applyEncounterDecision, EncounterJobFailure } from '../normalization/encounter-service.js';

async function requireAnyEditor(accountId: string): Promise<void> {
  const row = (await db
    .select({ personId: personAccess.personId })
    .from(personAccess)
    .innerJoin(person, eq(person.id, personAccess.personId))
    .where(and(
      eq(personAccess.accountId, accountId),
      isNull(person.archivedAt),
      sql`${personAccess.role} in ('owner','editor')`,
    ))
    .limit(1))[0];
  if (!row) throw notFound();
}

async function editableFacilityFingerprints(accountId: string): Promise<Set<string>> {
  const rows = await db
    .select({ rawName: document.facilityNameRaw })
    .from(document)
    .innerJoin(personAccess, eq(personAccess.personId, document.personId))
    .innerJoin(person, eq(person.id, document.personId))
    .where(and(
      eq(personAccess.accountId, accountId),
      isNull(person.archivedAt),
      sql`${personAccess.role} in ('owner','editor')`,
      sql`${document.facilityNameRaw} is not null`,
      isNull(document.archivedAt),
    ));
  return new Set(rows
    .map((row) => row.rawName)
    .filter((rawName): rawName is string => rawName !== null)
    .map(facilityFingerprint));
}

async function editablePersonIds(accountId: string): Promise<Set<string>> {
  const rows = await db.select({ personId: personAccess.personId }).from(personAccess)
    .innerJoin(person, eq(person.id, personAccess.personId))
    .where(and(
      eq(personAccess.accountId, accountId), isNull(person.archivedAt),
      sql`${personAccess.role} in ('owner','editor')`,
    ));
  return new Set(rows.map((row) => row.personId));
}

function visibleEncounter(row: typeof normalizationDecision.$inferSelect, personIds: Set<string>): boolean {
  if (row.kind !== 'encounter') return true;
  const proposal = EncounterProposal.safeParse(row.proposal);
  return proposal.success && personIds.has(proposal.data.person_id);
}

function decisionOut(row: typeof normalizationDecision.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind as 'facility' | 'encounter',
    input_fingerprint: row.inputFingerprint,
    proposal: row.proposal as Record<string, unknown>,
    state: row.state as 'proposed' | 'confirmed' | 'rejected',
    decided_by: row.decidedBy,
    decided_at: row.decidedAt?.toISOString() ?? null,
    client_operation_id: row.clientOperationId,
    prompt_id: row.promptId,
    prompt_version: row.promptVersion,
    model: row.model,
    created_at: row.createdAt.toISOString(),
  };
}

export function registerNormalizationRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/normalization-decisions',
    input: NormalizationDecisionListQuery,
    output: NormalizationDecisionListResponse,
    handler: async ({ input, accountId }) => {
      await requireAnyEditor(accountId);
      const visibleFacilityFingerprints = await editableFacilityFingerprints(accountId);
      const visiblePeople = await editablePersonIds(accountId);
      const conditions = [];
      if (input.kind) conditions.push(eq(normalizationDecision.kind, input.kind));
      if (input.state) conditions.push(eq(normalizationDecision.state, input.state));
      const rows = conditions.length === 0
        ? await db.select().from(normalizationDecision).orderBy(normalizationDecision.createdAt)
        : await db.select().from(normalizationDecision).where(and(...conditions)).orderBy(normalizationDecision.createdAt);
      return {
        decisions: rows
          .filter((row) => (row.kind !== 'facility' || visibleFacilityFingerprints.has(row.inputFingerprint))
            && visibleEncounter(row, visiblePeople))
          .map(decisionOut),
      };
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/normalization-decisions/:id/confirm',
    input: NormalizationConfirmRequest.extend({ id: Uuid }),
    output: NormalizationConfirmResponse,
    handler: async ({ input, accountId }) => {
      await requireAnyEditor(accountId);
      const editableFingerprints = await editableFacilityFingerprints(accountId);
      const editablePeople = await editablePersonIds(accountId);
      const result = await db.transaction(async (tx) => {
        const row = (await tx.select().from(normalizationDecision)
          .where(eq(normalizationDecision.id, input.id)).limit(1).for('update'))[0];
        if (!row) throw notFound();
        if (row.kind === 'facility' && !editableFingerprints.has(row.inputFingerprint)) throw notFound();
        if (!visibleEncounter(row, editablePeople)) throw notFound();
        if (row.clientOperationId === input.client_operation_id) {
          if (row.state !== input.decision) {
            throw new ApiError('validation_failed', 'client_operation_id 已用于不同的归一操作');
          }
          return row;
        }
        const reused = (await tx.select({ id: normalizationDecision.id }).from(normalizationDecision)
          .where(eq(normalizationDecision.clientOperationId, input.client_operation_id)).limit(1))[0];
        if (reused) throw new ApiError('validation_failed', 'client_operation_id 已用于不同的归一操作');
        if (row.state !== 'proposed') {
          throw new ApiError('validation_failed', '该归一建议已经完成审核，不能再次更改');
        }
        if (row.kind === 'facility') {
          await applyFacilityDecision(tx, row.inputFingerprint, row.proposal, input.decision);
        } else {
          try {
            await applyEncounterDecision(tx, row.proposal, input.decision);
          } catch (error) {
            if (error instanceof EncounterJobFailure) {
              throw new ApiError('validation_failed', error.message);
            }
            throw error;
          }
        }
        const at = serverTimestamp();
        let decisionPayload: Record<string, unknown> = row.proposal as Record<string, unknown>;
        if (row.kind === 'encounter') {
          const proposal = EncounterProposal.parse(row.proposal);
          const facilityRow = (await tx.select().from(facility)
            .where(eq(facility.id, proposal.facility_id)).limit(1))[0];
          if (!facilityRow) throw new ApiError('validation_failed', '归组建议引用的机构已经不存在');
          decisionPayload = EncounterDecisionPayload.parse({
            ...proposal,
            facility: {
              id: facilityRow.id, slug: facilityRow.slug, name: facilityRow.name,
              aliases: facilityRow.aliases, city: facilityRow.city, level: facilityRow.level,
            },
          });
        }
        await appendDecision(tx, {
          schema_version: '1.0', op: 'normalization_confirm', at,
          event_id: input.client_operation_id,
          by_account_id: accountId,
          client_operation_id: input.client_operation_id,
          kind: row.kind,
          input_fingerprint: row.inputFingerprint,
          decision: input.decision,
          payload: decisionPayload,
        });
        return (await tx.update(normalizationDecision).set({
          state: input.decision,
          decidedBy: accountId,
          decidedAt: new Date(at),
          clientOperationId: input.client_operation_id,
        }).where(eq(normalizationDecision.id, row.id)).returning())[0]!;
      });
      return { decision: decisionOut(result) };
    },
  });
}

export const normalizationRouteInternals = { decisionOut };
