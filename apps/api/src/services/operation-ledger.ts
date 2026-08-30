import { createHash } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import { canonicalJsonString } from '@amr/contracts';
import type { Tx } from '../db/client.js';
import { operationLedger } from '../db/schema.js';
import { ApiError } from '../errors.js';

export function operationRequestHash(request: unknown): string {
  return createHash('sha256').update(canonicalJsonString(request)).digest('hex');
}

export async function replayOperation<T>(
  tx: Tx,
  input: { accountId: string; clientOperationId: string; request: unknown },
): Promise<{ result: T; requestHash: string } | { result: null; requestHash: string }> {
  const requestHash = operationRequestHash(input.request);
  await tx.execute(sql`select pg_advisory_xact_lock(
    hashtextextended(${`${input.accountId}:${input.clientOperationId}`}, 0)
  )`);
  const prior = (await tx.select({
    requestHash: operationLedger.requestHash,
    result: operationLedger.result,
  }).from(operationLedger).where(and(
    eq(operationLedger.accountId, input.accountId),
    eq(operationLedger.clientOperationId, input.clientOperationId),
  )).limit(1))[0];
  if (!prior) return { result: null, requestHash };
  if (prior.requestHash !== requestHash) {
    throw new ApiError('operation_conflict', 'client_operation_id 已用于不同请求');
  }
  return { result: prior.result as T, requestHash };
}

export async function recordOperation(
  tx: Tx,
  input: {
    accountId: string; clientOperationId: string; kind: string; subjectType: string;
    subjectId: string | null; personId: string | null; requestHash: string;
    request: unknown; result: unknown;
  },
): Promise<void> {
  await tx.insert(operationLedger).values({
    accountId: input.accountId,
    clientOperationId: input.clientOperationId,
    kind: input.kind,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    personId: input.personId,
    requestHash: input.requestHash,
    request: input.request,
    result: input.result,
  });
}
