import { and, desc, eq } from 'drizzle-orm';
import {
  ObservationBatchCreateRequest, ObservationBatchCreateResponse,
  ObservationSuggestion, ObservationSuggestionAcceptResponse,
  ObservationSuggestionListResponse, ObservationSuggestionPayload,
  type ObservationSuggestionAcceptRequestT,
} from '@amr/contracts';
import { db } from '../db/client.js';
import { document, person, processingSuggestion } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { persistObservationBatch } from './observations.js';
import { replayOperation } from './operation-ledger.js';

type SuggestionRow = typeof processingSuggestion.$inferSelect;

function suggestionOut(row: SuggestionRow) {
  return ObservationSuggestion.parse({
    id: row.id, document_id: row.subjectId, person_id: row.personId,
    input_revision: row.inputRevision, input_sha256: row.inputSha256,
    payload: ObservationSuggestionPayload.parse(row.payload),
    provenance: {
      plugin_id: row.pluginId, plugin_version: row.pluginVersion,
      provider: row.provider, model: row.model, prompt_id: row.promptId,
      prompt_version: row.promptVersion, artifact_key: row.artifactKey,
      artifact_sha256: row.artifactSha256,
    },
    state: row.state, accepted_row_ids: row.acceptedFields,
    created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
  });
}

export async function listDocumentObservationSuggestions(documentId: string) {
  const rows = await db.select().from(processingSuggestion).where(and(
    eq(processingSuggestion.capability, 'observation_suggest'),
    eq(processingSuggestion.subjectType, 'document'),
    eq(processingSuggestion.subjectId, documentId),
  )).orderBy(desc(processingSuggestion.createdAt), desc(processingSuggestion.id));
  return ObservationSuggestionListResponse.parse({ suggestions: rows.map(suggestionOut) });
}

export async function acceptObservationSuggestion(input: {
  documentId: string; suggestionId: string; accountId: string;
  request: ObservationSuggestionAcceptRequestT;
}) {
  return db.transaction(async (tx) => {
    const operationRequest = {
      document_id: input.documentId, suggestion_id: input.suggestionId, ...input.request,
    };
    // 先查 operation ledger：即使已接受的 L2 suggestion 之后被删除，
    // 弱网重试仍必须返回首次 L1 结果。路由已先做 document 权限检查。
    const replay = await replayOperation<ReturnType<typeof ObservationBatchCreateResponse.parse>>(tx, {
      accountId: input.accountId,
      clientOperationId: input.request.client_operation_id,
      request: operationRequest,
    });
    if (replay.result) {
      const batch = ObservationBatchCreateResponse.parse(replay.result);
      return ObservationSuggestionAcceptResponse.parse({
        ...batch, suggestion_id: input.suggestionId,
        accepted_row_ids: input.request.rows.map((row) => row.suggestion_row_id),
      });
    }

    const owner = (await tx.select({
      personId: document.personId, personSlug: person.slug,
    }).from(document).innerJoin(person, eq(person.id, document.personId)).where(
      eq(document.id, input.documentId),
    ).limit(1).for('update'))[0];
    if (!owner) throw notFound();
    const stored = (await tx.select().from(processingSuggestion).where(and(
      eq(processingSuggestion.id, input.suggestionId),
      eq(processingSuggestion.capability, 'observation_suggest'),
      eq(processingSuggestion.subjectType, 'document'),
      eq(processingSuggestion.subjectId, input.documentId),
      eq(processingSuggestion.personId, owner.personId),
    )).limit(1).for('update'))[0];
    if (!stored || !['proposed', 'partially_accepted', 'accepted'].includes(stored.state)) {
      throw notFound();
    }
    if (input.request.if_input_revision !== stored.inputRevision) {
      throw new ApiError('revision_conflict', 'observation suggestion 输入版本已变更', {
        base_revision: input.request.if_input_revision,
        current: suggestionOut(stored),
        draft: input.request,
      });
    }

    const suggestion = suggestionOut(stored);
    const available = new Map(suggestion.payload.rows.map((row) => [row.row_id, row]));
    const sourceRefs = new Map<string, Record<string, unknown>>();
    const acceptedRows = input.request.rows.map((selection, index) => {
      const proposed = available.get(selection.suggestion_row_id);
      if (!proposed) {
        throw new ApiError('validation_failed', `suggestion 不包含行 ${selection.suggestion_row_id}`, {
          issues: [{ code: 'custom', path: ['rows', index, 'suggestion_row_id'], message: '行不存在' }],
        });
      }
      const draft = { ...proposed.draft, ...selection.overrides };
      if (draft.document_id !== undefined && draft.document_id !== null
          && draft.document_id !== input.documentId) {
        throw new ApiError('validation_failed', 'suggestion row 不得改指其他文档');
      }
      if (draft.source_page
          && draft.source_page.origin_capture_document_id !== input.documentId) {
        throw new ApiError('validation_failed', 'suggestion 来源页必须属于当前文档');
      }
      sourceRefs.set(selection.client_row_id, {
        suggestion_id: suggestion.id,
        suggestion_row_id: proposed.row_id,
        input_revision: suggestion.input_revision,
        input_sha256: suggestion.input_sha256,
        proposed: proposed.draft,
        overrides: selection.overrides,
        provenance: suggestion.provenance,
      });
      return {
        ...draft, document_id: input.documentId, client_row_id: selection.client_row_id,
      };
    });
    const batch = ObservationBatchCreateRequest.parse({
      client_operation_id: input.request.client_operation_id,
      defaults: { ...suggestion.payload.defaults, document_id: input.documentId },
      observations: acceptedRows,
    });
    const suggestionSnapshot = {
      suggestion_id: suggestion.id, input_revision: suggestion.input_revision,
      input_sha256: suggestion.input_sha256, provenance: suggestion.provenance,
      accepted_rows: input.request.rows.map((selection) => ({
        suggestion_row_id: selection.suggestion_row_id,
        client_row_id: selection.client_row_id,
        overrides: selection.overrides,
      })),
    };
    const response = await persistObservationBatch({
      tx, personId: owner.personId, accountId: input.accountId, ownerSlug: owner.personSlug,
      body: batch, request: operationRequest, requestHash: replay.requestHash,
      source: 'accepted_suggestion', sourceRefs, suggestionSnapshot,
    });
    const acceptedRowIds = [...new Set([
      ...stored.acceptedFields,
      ...input.request.rows.map((row) => row.suggestion_row_id),
    ])];
    const state = suggestion.payload.rows.every((row) => acceptedRowIds.includes(row.row_id))
      ? 'accepted' : 'partially_accepted';
    await tx.update(processingSuggestion).set({
      acceptedFields: acceptedRowIds, state, updatedAt: new Date(),
    }).where(eq(processingSuggestion.id, stored.id));
    return ObservationSuggestionAcceptResponse.parse({
      ...response, suggestion_id: suggestion.id, accepted_row_ids: acceptedRowIds,
    });
  });
}
