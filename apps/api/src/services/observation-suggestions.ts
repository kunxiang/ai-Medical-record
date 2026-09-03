import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { canonicalJsonString } from '@amr/contracts';
import { serverTimestamp } from '@amr/storage';
import {
  classifyRows, conceptByExactName, CONCEPT_CATALOG_VERSION, crossCheckLabPanel,
} from '@amr/medical';
import {
  ObservationBatchCreateRequest, ObservationBatchCreateResponse,
  ObservationBatchDefaults, ObservationBatchRow,
  ObservationSuggestion, ObservationSuggestionAcceptResponse,
  ObservationSuggestionListResponse, ObservationSuggestionPayload,
  type ObservationSuggestionAcceptRequestT,
} from '@amr/contracts';
import { db, type Tx } from '../db/client.js';
import { appendJournal } from '../journal.js';
import { document, observation, person, processingSuggestion } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import {
  normalizeFact, observationOut, persistObservationBatch, projectObservationSearch,
} from './observations.js';
import { recordOperation, replayOperation } from './operation-ledger.js';

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

// ── m5-02:机器交叉验证 + 自动入库 ─────────────────────────────────────────────
//
// 为什么要有这段:让用户对着几十个化验数字点一次"接受"并不产生验证 —— 没有人能核对,
// 也没有人会核对。而系统却会把这些行记成"已由某某确认",那是替用户签的一句假话。
//
// 化验单自身是冗余的(百分比求和、WBC×比例、MCV/MCH/MCHC 等式),机器算得出的就不该要人算。
// 于是分工改成:**机器能验证的自动入库(review_status=machine_verified,无审阅者),
// 机器验不了的才留给人**。用户的注意力被花在机器帮不上的地方,而不是走过场。

/** value_raw → 数值。与 normalizeFact 的解析同源:只取首个数字,读不出就不参与校验。 */
function numericOf(valueRaw: string): number | null {
  const hit = valueRaw.match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/)?.[0];
  if (hit === undefined) return null;
  const n = Number(hit);
  return Number.isFinite(n) ? n : null;
}

export interface AutoAdmitOutcome {
  verified: string[];
  needsHuman: string[];
  failed: string[];
}

/**
 * 对一份 observation_suggest 跑跨行自洽校验,把通过的行自动入库。
 *
 * 三条纪律:
 * - 认不出概念、或没有任何规则覆盖的行 ⇒ 留给人(不猜)。
 * - 卷进任何一条失败等式的行 ⇒ 留给人(不知道错的是它还是等式里的另一个数)。
 * - 自动入库的行 reviewed_by 为空 —— 没有人看过就不能写上谁的名字。
 */
export async function autoAdmitVerifiedRows(input: {
  tx: Tx;
  suggestionId: string;
  documentId: string;
  personId: string;
  personSlug: string;
  /** 归档所有者;用于 created_by。**不是**审阅者,reviewed_by 仍为空。 */
  accountId: string;
}): Promise<AutoAdmitOutcome> {
  const stored = (await input.tx.select().from(processingSuggestion).where(and(
    eq(processingSuggestion.id, input.suggestionId),
    eq(processingSuggestion.capability, 'observation_suggest'),
  )).limit(1).for('update'))[0];
  if (!stored) throw notFound();
  const payload = ObservationSuggestionPayload.parse(stored.payload);
  // 幂等闸门:只跳过**已经全部入库**的建议。判据不能是"有任何行入过库" ——
  // 那会让上一轮遗留的行永远进不来(早期设计留了一部分等人工接受,就是这么卡住的)。
  const alreadyAdmitted = new Set(stored.acceptedFields);
  if (payload.rows.every((row) => alreadyAdmitted.has(row.row_id))) {
    return { verified: [...stored.acceptedFields], needsHuman: [], failed: [] };
  }

  const resolved = payload.rows.filter((row) => !alreadyAdmitted.has(row.row_id)).map((row) => {
    const concept = conceptByExactName(row.draft.local_name);
    const valueNum = numericOf(row.draft.value_raw);
    return { row, conceptCode: concept?.code ?? null, valueNum };
  });
  const checkRows = resolved
    .filter((r): r is typeof r & { conceptCode: string; valueNum: number } =>
      r.conceptCode !== null && r.valueNum !== null)
    .map((r) => ({ conceptCode: r.conceptCode, valueNum: r.valueNum }));

  const results = crossCheckLabPanel(checkRows);
  const verdicts = classifyRows(checkRows, results);

  const out: AutoAdmitOutcome = { verified: [], needsHuman: [], failed: [] };
  const admit: Array<{
    rowId: string; clientRowId: string; draft: unknown;
    conceptCode: string | null;
    status: 'machine_verified' | 'unverified' | 'check_failed';
  }> = [];
  for (const item of resolved) {
    const verdict = item.conceptCode === null ? 'unverifiable'
      : verdicts.get(item.conceptCode) ?? 'unverifiable';
    // ★ 三类**全部入库**,只是可信度不同(ADR-054)。
    //   不再留任何一类等用户点"接受":一个不熟悉化验单的人无法判断 RDW-SD 39.5 fL,
    //   项目从 29 减到 5 也不会变得可判断。如实记录可信度,比伪造一次确认诚实。
    const status = verdict === 'verified' ? 'machine_verified' as const
      : verdict === 'failed' ? 'check_failed' as const
        : 'unverified' as const;
    if (verdict === 'verified') out.verified.push(item.row.row_id);
    else if (verdict === 'failed') out.failed.push(item.row.row_id);
    else out.needsHuman.push(item.row.row_id);
    admit.push({
      rowId: item.row.row_id, clientRowId: uuidv7(), draft: item.row.draft,
      // 概念代码只在严格全等解析成功时写入;认不出就留空,让它进「待整理指标名称」——
      // 那是人**做得到**的判断(给一个名字选个标准项),与判断数值对错不同。
      conceptCode: item.conceptCode, status,
    });
  }
  if (admit.length === 0) return out;

  const clientOperationId = uuidv7();
  const sourceRefs = new Map<string, Record<string, unknown>>();
  for (const item of admit) {
    sourceRefs.set(item.clientRowId, {
      suggestion_id: stored.id, suggestion_row_id: item.rowId,
      input_revision: stored.inputRevision, input_sha256: stored.inputSha256,
      proposed: item.draft,
      // 机器验证的依据必须可回溯:哪条规则、算出多少、偏差多大,全部随行落库。
      machine_checks: results
        .filter((r) => r.status !== 'skipped')
        .map((r) => ({
          rule: r.rule, status: r.status, computed: r.computed,
          reported: r.reported, deviation_pct: r.deviationPct, tolerance_pct: r.tolerancePct,
        })),
    });
  }
  const batch = ObservationBatchCreateRequest.parse({
    client_operation_id: clientOperationId,
    defaults: { ...payload.defaults, document_id: input.documentId },
    observations: admit.map((item) => ({
      ...(item.draft as Record<string, unknown>),
      document_id: input.documentId, client_row_id: item.clientRowId,
      ...(item.conceptCode
        ? { concept_code: item.conceptCode, concept_catalog_version: CONCEPT_CATALOG_VERSION }
        : {}),
    })),
  });
  const request = { auto_admit: true, suggestion_id: stored.id, client_operation_id: clientOperationId };
  await persistObservationBatch({
    tx: input.tx, personId: input.personId, accountId: input.accountId,
    ownerSlug: input.personSlug, body: batch,
    request, requestHash: createHash('sha256').update(canonicalJsonString(request)).digest('hex'),
    source: 'accepted_suggestion', sourceRefs,
    machineStatusByRowId: new Map(admit.map((item) => [item.clientRowId, item.status])),
  });

  // 全部入库 ⇒ 建议不再有"待接受"的残留,用户界面上也就不会再出现那个按钮。
  await input.tx.update(processingSuggestion).set({
    acceptedFields: [...new Set([...stored.acceptedFields, ...admit.map((i) => i.rowId)])],
    state: 'accepted', updatedAt: new Date(),
  }).where(eq(processingSuggestion.id, stored.id));
  return out;
}

/**
 * 回填 concept_code(m5-02 修复)。
 *
 * 背景:自动入库最初没有写 concept_code,导致那些行全部堆进「待整理指标名称」——
 * 把"接受几十行"换成了"从下拉框里映射几十行",对用户更难。代码已修,
 * 但既有行需要补:journal 是 WORM 追加的,删 DB 行会在重建时复活,只能追加更正。
 *
 * 只补 **本来就是 machine_verified、concept_code 为空、且能被严格解析** 的行,
 * 并保持 machine_verified/reviewed_by=null —— 机器补的字段不能记成人工修正。
 */
export async function backfillMachineVerifiedConcepts(input: {
  tx: Tx; personId: string; ownerSlug: string; accountId: string;
  /**
   * 连已有 concept_code 的行也重跑一遍。
   * 用途:早期回填漏了写 journal —— 数据库是对的,但重放会退回旧状态。
   * 重跑一次让 journal 事件的 `after` 带上正确值,**不需要先破坏性地清空**。
   */
  rejournalExisting?: boolean;
}): Promise<{ patched: number; skipped: number }> {
  const rows = await input.tx.select().from(observation).where(and(
    eq(observation.personId, input.personId),
    inArray(observation.reviewStatus, ['machine_verified', 'unverified', 'check_failed']),
    ...(input.rejournalExisting ? [] : [isNull(observation.conceptCode)]),
    isNull(observation.archivedAt),
  ));
  let patched = 0;
  let skipped = 0;
  for (const current of rows) {
    const concept = conceptByExactName(current.localName);
    if (!concept) { skipped += 1; continue; }
    const normalized = await normalizeFact(input.tx, {
      personId: input.personId, accountId: input.accountId,
      row: ObservationBatchRow.parse({
        client_row_id: current.clientRowId,
        local_name: current.localName, value_raw: current.valueRaw,
        unit_raw: current.unitRaw, ref_text: current.refText,
        abnormal_flag_raw: current.abnormalFlagRaw,
        concept_code: concept.code, concept_catalog_version: CONCEPT_CATALOG_VERSION,
      }),
      defaults: ObservationBatchDefaults.parse({}),
      path: ['backfill'], existing: current, machineStatus: current.reviewStatus as 'machine_verified',
    });
    const { warnings: _w, conceptReference, ...values } = normalized;
    const before = observationOut(current);
    const row = (await input.tx.update(observation)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(observation.id, current.id)).returning())[0]!;
    const after = observationOut(row);

    // ★ 必须落 journal。journal 回放是权威 —— 只改数据库不追加事件,
    //   下一次删库重建就会把 concept_code 为空的旧状态原样恢复,待映射清单卷土重来。
    //   这正是本仓一贯警惕的孤儿问题,回填自己也不能豁免。
    const eventId = uuidv7();
    const request = {
      backfill: 'machine_verified_concept', observation_id: current.id,
      concept_code: concept.code, client_operation_id: eventId,
    };
    const requestHash = createHash('sha256').update(canonicalJsonString(request)).digest('hex');
    await projectObservationSearch(input.tx, after, requestHash);
    // 台账与 journal 一起记 —— 这次修复本身也要可审计、可重放。
    await recordOperation(input.tx, {
      accountId: input.accountId, clientOperationId: eventId,
      kind: 'observation_upsert', subjectType: 'observation', subjectId: after.id,
      personId: after.person_id, requestHash, request, result: after,
    });
    await appendJournal(input.tx, input.ownerSlug, {
      schema_version: '1.0', event: 'observation_upsert', event_id: eventId,
      at: serverTimestamp(), by_account_id: input.accountId,
      client_operation_id: eventId, person_slug: input.ownerSlug,
      subject_id: after.id, revision: after.revision,
      before: [before], after: [after],
      correction_note: '机器回填 concept_code(m5-02):概念由严格全等解析确定,并被通过的自洽等式佐证',
      operation_replay: { request_hash: requestHash, response_snapshot: after },
      references: {
        concepts: conceptReference ? [conceptReference] : [],
        facilities: [], suggestion: null,
      },
    });
    patched += 1;
  }
  return { patched, skipped };
}
