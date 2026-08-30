import { createHash } from 'node:crypto';
import { and, eq, isNull, max, sql } from 'drizzle-orm';
import {
  canonicalJsonString,
  type ProcessingCapabilityT,
} from '@amr/contracts';
import { db, type Tx } from '../db/client.js';
import { document, documentPage, processingJob, processingPlugin } from '../db/schema.js';
import { env } from '../env.js';
import { ACTIVE_PLUGIN_MAX_AGE_MS } from './constants.js';
import { enqueueProcessing } from './queue.js';

async function activePluginFor(tx: Tx, capability: ProcessingCapabilityT): Promise<{
  pluginId: string;
  pluginVersion: string;
} | null> {
  if (env.processingMode !== 'assist') return null;
  const row = (await tx.select({
    pluginId: processingPlugin.pluginId,
    pluginVersion: processingPlugin.pluginVersion,
  }).from(processingPlugin).where(and(
    sql`${processingPlugin.lastHeartbeatAt} >= ${new Date(Date.now() - ACTIVE_PLUGIN_MAX_AGE_MS)}`,
    sql`${capability} = any(${processingPlugin.capabilities})`,
  )).orderBy(processingPlugin.pluginId).limit(1))[0];
  return row ?? null;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJsonString(value)).digest('hex');
}

async function enqueueDocumentMetadataWithPlugin(
  tx: Tx,
  current: { id: string; personId: string },
  plugin: { pluginId: string; pluginVersion: string },
  runGeneration: number,
): Promise<{ id: string; inserted: boolean }> {
  const pages = await tx.select({
    pageNo: documentPage.pageNo,
    captureOrder: documentPage.captureOrder,
    sha256: documentPage.contentSha256,
  }).from(documentPage).where(eq(documentPage.documentId, current.id)).orderBy(documentPage.pageNo);
  return enqueueProcessing(tx, {
    capability: 'document_metadata_suggest',
    target_plugin_id: plugin.pluginId,
    target_plugin_version: plugin.pluginVersion,
    subject_type: 'document',
    subject_id: current.id,
    person_id: current.personId,
    input_revision: 0,
    input_sha256: sha256({ document_id: current.id, pages }),
    run_generation: runGeneration,
  });
}

export async function scheduleDocumentMetadata(
  documentId: string,
  runGeneration = 0,
): Promise<{ id: string; inserted: boolean } | null> {
  if (env.processingMode !== 'assist') return null;
  return db.transaction(async (tx) => {
    const plugin = await activePluginFor(tx, 'document_metadata_suggest');
    if (!plugin) return null;
    const current = (await tx.select({ id: document.id, personId: document.personId })
      .from(document).where(eq(document.id, documentId)).limit(1))[0];
    if (!current) return null;
    return enqueueDocumentMetadataWithPlugin(tx, current, plugin, runGeneration);
  });
}

/** 显式重跑每次分配新的 generation；锁住文档，避免并发请求共用同一代。 */
export async function scheduleDocumentMetadataRerun(
  documentId: string,
): Promise<{ id: string; inserted: boolean } | null> {
  if (env.processingMode !== 'assist') return null;
  return db.transaction(async (tx) => {
    const plugin = await activePluginFor(tx, 'document_metadata_suggest');
    if (!plugin) return null;
    const current = (await tx.select({ id: document.id, personId: document.personId }).from(document)
      .where(eq(document.id, documentId)).limit(1).for('update'))[0];
    if (!current) return null;
    const previous = (await tx.select({ value: max(processingJob.runGeneration) })
      .from(processingJob).where(and(
        eq(processingJob.capability, 'document_metadata_suggest'),
        eq(processingJob.subjectType, 'document'),
        eq(processingJob.subjectId, documentId),
        eq(processingJob.targetPluginId, plugin.pluginId),
        eq(processingJob.targetPluginVersion, plugin.pluginVersion),
      )))[0]?.value ?? -1;
    return enqueueDocumentMetadataWithPlugin(tx, current, plugin, previous + 1);
  });
}

export async function scheduleFacilitySuggestion(
  tx: Tx,
  inputFingerprint: string,
): Promise<{ id: string; inserted: boolean } | null> {
  const plugin = await activePluginFor(tx, 'facility_suggest');
  if (!plugin) return null;
  return enqueueProcessing(tx, {
    capability: 'facility_suggest',
    target_plugin_id: plugin.pluginId,
    target_plugin_version: plugin.pluginVersion,
    subject_type: 'family',
    subject_id: `facility:${inputFingerprint}`,
    person_id: null,
    input_revision: 0,
    input_sha256: inputFingerprint,
    run_generation: 0,
  });
}

export async function scheduleEncounterSuggestion(
  tx: Tx,
  personId: string,
): Promise<{ id: string; inserted: boolean } | null> {
  const plugin = await activePluginFor(tx, 'encounter_suggest');
  if (!plugin) return null;
  const candidates = await tx.select({
    id: document.id,
    facilityId: document.facilityId,
    sampledOn: document.sampledOn,
    reportedOn: document.reportedOn,
    eventTime: document.eventTime,
  }).from(document).where(and(
    eq(document.personId, personId),
    isNull(document.encounterId),
    isNull(document.archivedAt),
  )).orderBy(document.id);
  const inputSha256 = sha256({ person_id: personId, candidates });
  return enqueueProcessing(tx, {
    capability: 'encounter_suggest',
    target_plugin_id: plugin.pluginId,
    target_plugin_version: plugin.pluginVersion,
    subject_type: 'person',
    subject_id: personId,
    person_id: personId,
    input_revision: 0,
    input_sha256: inputSha256,
    run_generation: 0,
  });
}

export const processingSchedulingInternals = { ACTIVE_PLUGIN_MAX_AGE_MS, sha256 };
