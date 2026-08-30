import { createHash } from 'node:crypto';
import {
  and, desc, eq, inArray, isNull, lt, or, sql,
} from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  DocumentMetadataPatch, ManualMetadataField, MetadataMigrationInboxResponse,
  MetadataSuggestion, MetadataSuggestionAcceptResponse, MetadataSuggestionListResponse,
  MetadataSuggestionValues, canonicalJsonString,
  type DocumentManualMetadataSnapshotT,
} from '@amr/contracts';
import { db } from '../db/client.js';
import {
  document, documentManualMetadata, processingSuggestion,
} from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { mutateDocumentMetadata } from './metadata.js';
import { replayOperation } from './operation-ledger.js';

const LEGACY_PLUGIN_ID = 'legacy-stage1';
const LEGACY_PLUGIN_VERSION = 'migration-v1';

type SuggestionRow = typeof processingSuggestion.$inferSelect;

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJsonString(value)).digest('hex');
}

function suggestionOut(row: SuggestionRow) {
  return MetadataSuggestion.parse({
    id: row.id,
    document_id: row.subjectId,
    input_revision: row.inputRevision,
    values: MetadataSuggestionValues.parse(row.payload),
    provenance: {
      plugin_id: row.pluginId,
      plugin_version: row.pluginVersion,
      provider: row.provider,
      model: row.model,
      prompt_id: row.promptId,
      prompt_version: row.promptVersion,
      artifact_key: row.artifactKey,
      artifact_sha256: row.artifactSha256,
    },
    state: row.state,
    accepted_fields: row.acceptedFields,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

/**
 * 把旧 document 上的 Stage 1 L2 列实体化为可审核 suggestion。
 * 这是幂等 L2 backfill；插件关闭时仍可执行，不调用供应商也不提升为事实。
 */
export async function materializeLegacyMetadataSuggestions(input: {
  personId?: string;
  documentId?: string;
}): Promise<number> {
  const conditions = [isNull(document.archivedAt)];
  if (input.personId) conditions.push(eq(document.personId, input.personId));
  if (input.documentId) conditions.push(eq(document.id, input.documentId));
  const rows = await db.select({
    id: document.id,
    personId: document.personId,
    docType: document.docType,
    sampledOn: document.sampledOn,
    reportedOn: document.reportedOn,
    facilityNameRaw: document.facilityNameRaw,
    departmentRaw: document.departmentRaw,
    s1ArtifactKey: document.s1ArtifactKey,
    s1PromptVersion: document.s1PromptVersion,
  }).from(document).where(and(...conditions));

  let inserted = 0;
  for (const row of rows) {
    const values = MetadataSuggestionValues.parse({
      ...(row.docType !== 'unknown' ? { doc_type: row.docType } : {}),
      ...(row.sampledOn !== null ? { sampled_on: row.sampledOn } : {}),
      ...(row.reportedOn !== null ? { reported_on: row.reportedOn } : {}),
      ...(row.facilityNameRaw !== null ? { facility_name_raw: row.facilityNameRaw } : {}),
      ...(row.departmentRaw !== null ? { department: row.departmentRaw } : {}),
    });
    if (Object.keys(values).length === 0) continue;
    const inputSha256 = sha256({ document_id: row.id, values, artifact_key: row.s1ArtifactKey });
    const result = await db.insert(processingSuggestion).values({
      id: uuidv7(), capability: 'document_metadata_suggest',
      subjectType: 'document', subjectId: row.id, personId: row.personId,
      inputRevision: 0, inputSha256, payload: values,
      pluginId: LEGACY_PLUGIN_ID, pluginVersion: LEGACY_PLUGIN_VERSION,
      promptId: row.s1PromptVersion === null ? null : 'stage1',
      promptVersion: row.s1PromptVersion?.toString() ?? null,
      artifactKey: row.s1ArtifactKey,
    }).onConflictDoNothing({
      target: [
        processingSuggestion.capability, processingSuggestion.subjectType,
        processingSuggestion.subjectId, processingSuggestion.pluginId,
        processingSuggestion.pluginVersion, processingSuggestion.inputSha256,
      ],
    }).returning({ id: processingSuggestion.id });
    if (result.length > 0) inserted += 1;
  }
  return inserted;
}

export async function listDocumentMetadataSuggestions(documentId: string) {
  await materializeLegacyMetadataSuggestions({ documentId });
  const rows = await db.select().from(processingSuggestion).where(and(
    eq(processingSuggestion.capability, 'document_metadata_suggest'),
    eq(processingSuggestion.subjectType, 'document'),
    eq(processingSuggestion.subjectId, documentId),
  )).orderBy(desc(processingSuggestion.createdAt), desc(processingSuggestion.id));
  return MetadataSuggestionListResponse.parse({ suggestions: rows.map(suggestionOut) });
}

function encodeInboxCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ at: row.createdAt.toISOString(), id: row.id })).toString('base64url');
}

function decodeInboxCursor(cursor: string): { at: Date; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at)) || typeof value.id !== 'string') {
      throw new Error('invalid cursor');
    }
    return { at: new Date(value.at), id: value.id };
  } catch {
    throw new ApiError('validation_failed', '游标无效');
  }
}

export async function listMetadataMigrationInbox(input: {
  personId: string;
  cursor?: string;
  limit: number;
}) {
  await materializeLegacyMetadataSuggestions({ personId: input.personId });
  const conditions = [
    eq(processingSuggestion.personId, input.personId),
    eq(processingSuggestion.capability, 'document_metadata_suggest'),
    eq(processingSuggestion.subjectType, 'document'),
    inArray(processingSuggestion.state, ['proposed', 'partially_accepted']),
    isNull(document.archivedAt),
  ];
  if (input.cursor) {
    const cursor = decodeInboxCursor(input.cursor);
    conditions.push(or(
      lt(processingSuggestion.createdAt, cursor.at),
      and(eq(processingSuggestion.createdAt, cursor.at), lt(processingSuggestion.id, cursor.id)),
    )!);
  }
  const rows = await db.select({
    suggestion: processingSuggestion,
    metadata: documentManualMetadata,
    originalFilename: document.originalFilename,
  }).from(processingSuggestion)
    .innerJoin(document, sql`${processingSuggestion.subjectId} = ${document.id}::text`)
    .leftJoin(documentManualMetadata, eq(documentManualMetadata.documentId, document.id))
    .where(and(...conditions))
    .orderBy(desc(processingSuggestion.createdAt), desc(processingSuggestion.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return MetadataMigrationInboxResponse.parse({
    items: page.map((row) => {
      const provenance = (row.metadata?.fieldProvenance ?? {}) as Record<string, {
        source: 'manual' | 'accepted_suggestion'; suggestion_id?: string | null;
      }>;
      const effective = <T>(field: string, value: T | null, fallback: T | null) => ({
        value: provenance[field] ? value : fallback,
        source: provenance[field]?.source ?? 'capture_fallback',
        suggestion_id: provenance[field]?.suggestion_id ?? null,
      });
      return {
        document_id: row.suggestion.subjectId,
        current_revision: row.metadata?.revision ?? 0,
        effective_metadata: {
          doc_type: effective('doc_type', row.metadata?.docType ?? null, 'unknown'),
          sampled_on: effective('sampled_on', row.metadata?.sampledOn ?? null, null),
          reported_on: effective('reported_on', row.metadata?.reportedOn ?? null, null),
          facility_name: effective(
            provenance.facility_id ? 'facility_id' : 'facility_name_raw',
            row.metadata?.facilityNameRaw ?? null, null,
          ),
          department: effective('department', row.metadata?.department ?? null, null),
          title: effective('title', row.metadata?.title ?? null, row.originalFilename),
          note: effective('note', row.metadata?.note ?? null, null),
        },
        suggestion: suggestionOut(row.suggestion),
      };
    }),
    next_cursor: rows.length > input.limit && last
      ? encodeInboxCursor({ createdAt: last.suggestion.createdAt, id: last.suggestion.id })
      : null,
  });
}

function snapshotFields(
  snapshot: DocumentManualMetadataSnapshotT | null,
  fields: string[],
): Record<string, unknown> {
  const source = snapshot as Record<string, unknown> | null;
  return Object.fromEntries(fields.map((field) => [field, source?.[field] ?? null]));
}

export async function acceptMetadataSuggestion(input: {
  documentId: string;
  suggestionId: string;
  accountId: string;
  request: {
    client_operation_id: string;
    if_revision: number;
    fields: string[];
    overrides: Record<string, unknown>;
  };
}) {
  return db.transaction(async (tx) => {
    const operationRequest = {
      document_id: input.documentId,
      suggestion_id: input.suggestionId,
      ...input.request,
    };
    const replay = await replayOperation<ReturnType<typeof MetadataSuggestionAcceptResponse.parse>>(tx, {
      accountId: input.accountId,
      clientOperationId: input.request.client_operation_id,
      request: operationRequest,
    });
    if (replay.result) return MetadataSuggestionAcceptResponse.parse(replay.result);

    const row = (await tx.select().from(processingSuggestion).where(and(
      eq(processingSuggestion.id, input.suggestionId),
      eq(processingSuggestion.capability, 'document_metadata_suggest'),
      eq(processingSuggestion.subjectType, 'document'),
      eq(processingSuggestion.subjectId, input.documentId),
    )).limit(1).for('update'))[0];
    if (!row) throw notFound();
    if (!['proposed', 'partially_accepted', 'accepted'].includes(row.state)) throw notFound();
    const suggestion = suggestionOut(row);
    const values = suggestion.values as Record<string, unknown>;
    const patchValues: Record<string, unknown> = {};
    for (const field of input.request.fields) {
      if (Object.prototype.hasOwnProperty.call(input.request.overrides, field)) {
        patchValues[field] = input.request.overrides[field];
      } else if (Object.prototype.hasOwnProperty.call(values, field)) {
        patchValues[field] = values[field];
      } else {
        throw new ApiError('validation_failed', `建议不包含字段 ${field}`);
      }
    }
    const patch = DocumentMetadataPatch.parse({
      client_operation_id: input.request.client_operation_id,
      if_revision: input.request.if_revision,
      ...patchValues,
    });
    const suggestionSnapshot = {
      suggestion_id: suggestion.id,
      accepted_fields: input.request.fields,
      values: suggestion.values,
      provenance: suggestion.provenance,
    };
    const mutation = await mutateDocumentMetadata({
      documentId: input.documentId,
      accountId: input.accountId,
      patch,
      tx,
      attribution: {
        source: 'accepted_suggestion', suggestionId: suggestion.id, suggestionSnapshot,
      },
      requestOverride: operationRequest,
      buildResult: ({ response, before, after }) => MetadataSuggestionAcceptResponse.parse({
        ...response,
        suggestion_id: suggestion.id,
        before: snapshotFields(before, input.request.fields),
        after: snapshotFields(after, input.request.fields),
      }),
    });
    const acceptedFields = [...new Set([...row.acceptedFields, ...input.request.fields])]
      .filter((field) => ManualMetadataField.options.includes(field as never));
    const availableFields = Object.keys(values);
    const state = availableFields.every((field) => acceptedFields.includes(field))
      ? 'accepted' : 'partially_accepted';
    await tx.update(processingSuggestion).set({
      acceptedFields, state, updatedAt: new Date(),
    }).where(eq(processingSuggestion.id, row.id));
    return MetadataSuggestionAcceptResponse.parse(mutation.result);
  });
}
