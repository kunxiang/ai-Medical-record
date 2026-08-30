import { and, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  ProcessingJobEnvelope,
  ProcessingPluginHeartbeat,
  processingDedupKey,
  type ProcessingCapabilityT,
  type ProcessingJobEnvelopeT,
} from '@amr/contracts';
import { db, type Tx } from '../db/client.js';
import { processingJob, processingPlugin } from '../db/schema.js';
import { ACTIVE_PLUGIN_MAX_AGE_MS, DEFAULT_PROCESSING_LEASE_MS } from './constants.js';

export async function recordPluginHeartbeat(input: {
  pluginId: string;
  pluginVersion: string;
  capabilities: ProcessingCapabilityT[];
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  const heartbeat = ProcessingPluginHeartbeat.parse({
    plugin_id: input.pluginId,
    plugin_version: input.pluginVersion,
    capabilities: input.capabilities,
    last_heartbeat_at: now.toISOString(),
    metadata: input.metadata ?? {},
  });
  await db.insert(processingPlugin).values({
    pluginId: heartbeat.plugin_id,
    pluginVersion: heartbeat.plugin_version,
    capabilities: heartbeat.capabilities,
    lastHeartbeatAt: now,
    metadata: heartbeat.metadata,
  }).onConflictDoUpdate({
    target: processingPlugin.pluginId,
    set: {
      pluginVersion: heartbeat.plugin_version,
      capabilities: heartbeat.capabilities,
      lastHeartbeatAt: now,
      metadata: heartbeat.metadata,
    },
  });
}

export async function availablePlugins(maxAgeMs = ACTIVE_PLUGIN_MAX_AGE_MS): Promise<Array<{
  pluginId: string;
  pluginVersion: string;
  capabilities: ProcessingCapabilityT[];
  lastHeartbeatAt: Date;
  metadata: Record<string, unknown>;
}>> {
  const rows = await db.select().from(processingPlugin)
    .where(gte(processingPlugin.lastHeartbeatAt, new Date(Date.now() - maxAgeMs)))
    .orderBy(processingPlugin.pluginId);
  return rows.map((row) => ({
    pluginId: row.pluginId,
    pluginVersion: row.pluginVersion,
    capabilities: row.capabilities as ProcessingCapabilityT[],
    lastHeartbeatAt: row.lastHeartbeatAt,
    metadata: row.metadata as Record<string, unknown>,
  }));
}

export async function enqueueProcessing(
  tx: Tx,
  input: Omit<ProcessingJobEnvelopeT, 'id'> & { id?: string },
): Promise<{ id: string; inserted: boolean }> {
  const envelope = ProcessingJobEnvelope.parse({ ...input, id: input.id ?? uuidv7() });
  const dedupKey = processingDedupKey({
    capability: envelope.capability,
    targetPluginId: envelope.target_plugin_id,
    targetPluginVersion: envelope.target_plugin_version,
    subjectType: envelope.subject_type,
    subjectId: envelope.subject_id,
    inputSha256: envelope.input_sha256,
    runGeneration: envelope.run_generation,
  });
  const inserted = await tx.insert(processingJob).values({
    id: envelope.id,
    capability: envelope.capability,
    targetPluginId: envelope.target_plugin_id,
    targetPluginVersion: envelope.target_plugin_version,
    subjectType: envelope.subject_type,
    subjectId: envelope.subject_id,
    personId: envelope.person_id,
    inputRevision: envelope.input_revision,
    inputSha256: envelope.input_sha256,
    runGeneration: envelope.run_generation,
    dedupKey,
  }).onConflictDoNothing({ target: processingJob.dedupKey }).returning({ id: processingJob.id });
  if (inserted[0]) return { id: inserted[0].id, inserted: true };
  const existing = (await tx.select({ id: processingJob.id }).from(processingJob)
    .where(eq(processingJob.dedupKey, dedupKey)).limit(1))[0];
  if (!existing) throw new Error('processing job dedup conflict 后未找到既有作业');
  return { id: existing.id, inserted: false };
}

export interface ClaimedProcessingJob {
  id: string;
  capability: ProcessingCapabilityT;
  subjectType: ProcessingJobEnvelopeT['subject_type'];
  subjectId: string;
  personId: string | null;
  inputRevision: number;
  inputSha256: string;
  runGeneration: number;
  attempt: number;
}

export async function claimProcessingJobs(input: {
  instance: string;
  pluginId: string;
  pluginVersion: string;
  capabilities: ProcessingCapabilityT[];
  limit: number;
  leaseMs?: number;
}): Promise<ClaimedProcessingJob[]> {
  if (input.capabilities.length === 0 || input.limit < 1) return [];
  return db.transaction(async (tx) => {
    const picked = await tx.select({
      id: processingJob.id,
      capability: processingJob.capability,
      subjectType: processingJob.subjectType,
      subjectId: processingJob.subjectId,
      personId: processingJob.personId,
      inputRevision: processingJob.inputRevision,
      inputSha256: processingJob.inputSha256,
      runGeneration: processingJob.runGeneration,
      attempt: processingJob.attempt,
    }).from(processingJob).where(and(
      eq(processingJob.state, 'pending'),
      lte(processingJob.nextAttemptAt, new Date()),
      eq(processingJob.targetPluginId, input.pluginId),
      eq(processingJob.targetPluginVersion, input.pluginVersion),
      inArray(processingJob.capability, input.capabilities),
    )).orderBy(processingJob.nextAttemptAt, processingJob.id)
      .limit(input.limit).for('update', { skipLocked: true });
    if (picked.length === 0) return [];
    const now = new Date();
    await tx.update(processingJob).set({
      state: 'running',
      lockedAt: now,
      lockedBy: input.instance,
      leaseExpiresAt: new Date(now.getTime() + (input.leaseMs ?? DEFAULT_PROCESSING_LEASE_MS)),
      updatedAt: now,
    }).where(inArray(processingJob.id, picked.map((row) => row.id)));
    return picked as ClaimedProcessingJob[];
  });
}

export async function reclaimExpiredProcessingJobs(now = new Date()): Promise<number> {
  const rows = await db.update(processingJob).set({
    state: sql`case when ${processingJob.attempt} + 1 >= ${processingJob.maxAttempts} then 'failed' else 'pending' end`,
    attempt: sql`${processingJob.attempt} + 1`,
    nextAttemptAt: now,
    lockedAt: null,
    lockedBy: null,
    leaseExpiresAt: null,
    updatedAt: now,
  }).where(and(eq(processingJob.state, 'running'), lt(processingJob.leaseExpiresAt, now)))
    .returning({ id: processingJob.id });
  return rows.length;
}

export async function finishProcessingJob(input: {
  id: string;
  instance: string;
  state: 'done' | 'failed' | 'needs_human' | 'unsupported';
  resultKey?: string | null;
  resultSha256?: string | null;
  error?: Record<string, unknown> | null;
}): Promise<boolean> {
  const rows = await db.update(processingJob).set({
    state: input.state,
    resultKey: input.resultKey ?? null,
    resultSha256: input.resultSha256 ?? null,
    lastError: input.error ?? null,
    lockedAt: null,
    lockedBy: null,
    leaseExpiresAt: null,
    updatedAt: new Date(),
  }).where(and(eq(processingJob.id, input.id), eq(processingJob.lockedBy, input.instance)))
    .returning({ id: processingJob.id });
  return rows.length === 1;
}

export async function retryProcessingJob(input: {
  id: string;
  instance: string;
  error: Record<string, unknown>;
  delayMs?: number;
}): Promise<boolean> {
  const rows = await db.update(processingJob).set({
    state: sql`case when ${processingJob.attempt} + 1 >= ${processingJob.maxAttempts} then 'failed' else 'pending' end`,
    attempt: sql`${processingJob.attempt} + 1`,
    nextAttemptAt: new Date(Date.now() + (input.delayMs ?? 5_000)),
    lastError: input.error,
    lockedAt: null,
    lockedBy: null,
    leaseExpiresAt: null,
    updatedAt: new Date(),
  }).where(and(eq(processingJob.id, input.id), eq(processingJob.lockedBy, input.instance)))
    .returning({ id: processingJob.id });
  return rows.length === 1;
}
