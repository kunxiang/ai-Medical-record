import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  ObservationSuggestionPayload, S1Artifact, S2Artifact,
  type Stage2ObservationRowT,
} from '@amr/contracts';
import { callS2, getPrompt, S1_EFFORT, S2_PROMPT_ID, Stage2Error } from '@amr/ai';
import { buildKey, canonicalJson, serverTimestamp } from '@amr/storage';
import { db } from '../db/client.js';
import { document, person, processingSuggestion } from '../db/schema.js';
import { getObjectText, putWorm } from '../s3.js';
import { autoAdmitVerifiedRows } from '../services/observation-suggestions.js';
import type { JobFailure } from './queue.js';

// spec m5-01。Stage 2:化验单结果表 → observation 建议行。
//
// **范围刻意只有 lab_report 一种。** 路线图写的是"按 doc_type 分支",但目前只有化验单
// 有可结构化的结果表;为影像/输液单预写分支是投机,等真出现了再加。
//
// 输入是 S1 的 full_text,不重新看图(见 packages/ai/src/stage2.ts 的说明)。
// 输出永远只是 processing_suggestion —— 绝不直接写 observation。
// 成为事实的唯一路径是用户在 ObservationPanel 里逐行接受(ADR-051 assist-only)。

export class Stage2Failure extends Error {
  constructor(
    readonly terminal: 'needs_human' | 'failed' | 'unsupported' | null,
    readonly detail: JobFailure,
  ) {
    super(detail.message);
  }
}

interface Stage2Context {
  shortId: string;
  personId: string;
  personSlug: string;
  docType: string;
  sampledOn: string | null;
  s1ArtifactKey: string | null;
  /** 归档所有者。用于自动入库行的 created_by —— **不是** reviewed_by。 */
  uploadedBy: string;
}

async function loadContext(documentId: string): Promise<Stage2Context | null> {
  const rows = await db
    .select({
      shortId: document.shortId, personId: document.personId, personSlug: person.slug,
      docType: document.docType, sampledOn: document.sampledOn,
      s1ArtifactKey: document.s1ArtifactKey, uploadedBy: document.uploadedBy,
    })
    .from(document)
    .innerJoin(person, eq(person.id, document.personId))
    .where(eq(document.id, documentId))
    .limit(1);
  return rows[0] ?? null;
}

/** 多页化验单把各页 full_text 顺序拼起来;S1 已按页号排好。 */
function fullTextOf(artifactText: string): string {
  const artifact = S1Artifact.parse(JSON.parse(artifactText));
  return artifact.output.pages
    .map((page) => page.full_text ?? '')
    .filter((text) => text.trim().length > 0)
    .join('\n\n');
}

function toPayload(rows: Stage2ObservationRowT[], input: {
  documentId: string; sampledOn: string | null;
}) {
  return ObservationSuggestionPayload.parse({
    defaults: {
      document_id: input.documentId,
      // 化验单的观测日期就是采集日期。S1 没读出来时留空,由用户在接受时补 ——
      // 编一个日期比留空危险得多:它会静默地把这条数据放到趋势的错误位置上。
      ...(input.sampledOn ? { observed_on: input.sampledOn, date_source: 'document_sampled' } : {}),
    },
    rows: rows.map((row, index) => ({
      row_id: `row-${String(index + 1).padStart(2, '0')}`,
      draft: {
        local_name: row.local_name,
        value_raw: row.value_raw,
        unit_raw: row.unit_raw,
        ref_text: row.ref_text,
        abnormal_flag_raw: row.abnormal_flag_raw,
        // concept_code / unit_ucum / ref_low / ref_high / value_num 一律留空:
        // 它们各自已有确定性或人工的归一路径(mapping inbox、packages/medical),
        // 让模型去猜只会制造需要人工推翻的噪声。
      },
    })),
  });
}

export async function handleStage2(documentId: string, suggestionTarget?: {
  pluginId: string;
  pluginVersion: string;
  inputRevision: number;
  inputSha256: string;
}): Promise<{ resultKey: string }> {
  const ctx = await loadContext(documentId);
  if (!ctx) {
    throw new Stage2Failure('failed', {
      stage: 'load', code: 'document_not_found', message: `文档不存在: ${documentId}`,
    });
  }
  if (ctx.docType !== 'lab_report') {
    throw new Stage2Failure('unsupported', {
      stage: 's2', code: 'doc_type_unsupported',
      message: `Stage 2 目前只处理 lab_report,实际为 ${ctx.docType}`,
    });
  }
  if (!ctx.s1ArtifactKey) {
    throw new Stage2Failure('unsupported', {
      stage: 's2', code: 's1_missing', message: 'Stage 1 尚未产出工件',
    });
  }

  const s1 = await getObjectText(ctx.s1ArtifactKey);
  if (!s1) {
    throw new Stage2Failure('failed', {
      stage: 'load', code: 's1_artifact_missing', message: `S1 工件不可读: ${ctx.s1ArtifactKey}`,
    });
  }
  let fullText: string;
  try {
    fullText = fullTextOf(s1.text);
  } catch (error) {
    throw new Stage2Failure('failed', {
      stage: 'load', code: 's1_artifact_invalid',
      message: `S1 工件无法解析: ${String(error).slice(0, 200)}`,
    });
  }
  if (fullText.length === 0) {
    throw new Stage2Failure('unsupported', {
      stage: 's2', code: 'no_full_text', message: 'S1 未提取到全文,无从结构化',
    });
  }

  const prompt = getPrompt(S2_PROMPT_ID);
  const artifactKey = buildKey.extraction({
    personSlug: ctx.personSlug, docShortId: ctx.shortId, stage: 's2', promptVersion: prompt.version,
  });

  // 与 S1 同一条 412 路径:工件已存在 = "PUT 成功但 DB commit 前崩了"的重跑,重调模型纯属浪费。
  const existing = await getObjectText(artifactKey);
  let artifact;
  if (existing) {
    artifact = S2Artifact.parse(JSON.parse(existing.text));
  } else {
    let ran;
    try {
      ran = await callS2(fullText);
    } catch (error) {
      if (error instanceof Stage2Error) {
        // invalid_output / max_tokens 交给人,不要无限重试烧钱;传输类错误才重试。
        const terminal = error.kind === 'refusal' || error.kind === 'invalid_output'
          || error.kind === 'max_tokens' ? 'needs_human' : null;
        throw new Stage2Failure(terminal, {
          stage: 's2', code: error.kind, message: error.message,
        });
      }
      throw new Stage2Failure(null, {
        stage: 's2', code: 'unhandled', message: String(error).slice(0, 300),
      });
    }
    artifact = S2Artifact.parse({
      schema_version: '1.0', stage: 's2', document_short_id: ctx.shortId,
      produced_at: serverTimestamp(), model: ran.model,
      prompt_id: ran.promptId, prompt_version: ran.promptVersion, prompt_sha256: ran.promptSha256,
      effort: S1_EFFORT, source_s1_artifact_key: ctx.s1ArtifactKey,
      usage: {
        input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      },
      output: ran.output,
    });
    await putWorm(artifactKey, canonicalJson(artifact), 'application/json');
  }

  // 一行都没读出来是合法结果(例如影像报告被误分类成化验单):记工件、不产建议。
  if (artifact.output.rows.length === 0) return { resultKey: artifactKey };

  if (suggestionTarget) {
    await db.transaction(async (tx) => {
    const inserted = await tx.insert(processingSuggestion).values({
      id: uuidv7(), capability: 'observation_suggest',
      subjectType: 'document', subjectId: documentId, personId: ctx.personId,
      inputRevision: suggestionTarget.inputRevision,
      inputSha256: suggestionTarget.inputSha256,
      payload: toPayload(artifact.output.rows, {
        documentId, sampledOn: ctx.sampledOn,
      }),
      pluginId: suggestionTarget.pluginId,
      pluginVersion: suggestionTarget.pluginVersion,
      model: artifact.model,
      promptId: artifact.prompt_id,
      promptVersion: String(artifact.prompt_version),
      artifactKey,
      artifactSha256: createHash('sha256').update(canonicalJson(artifact)).digest('hex'),
    }).onConflictDoNothing({
      target: [
        processingSuggestion.capability, processingSuggestion.subjectType,
        processingSuggestion.subjectId, processingSuggestion.pluginId,
        processingSuggestion.pluginVersion, processingSuggestion.inputSha256,
      ],
    }).returning({ id: processingSuggestion.id });

    // ★ m5-02:立刻跑跨行自洽校验,把机器能验证的行自动入库。
    //   剩下的(认不出概念、无规则覆盖、或卷进失败等式)才留给人 ——
    //   用户的注意力只花在机器帮不上的地方,而不是对着几十个数字走过场。
    const suggestionId = inserted[0]?.id;
    if (suggestionId) {
      const outcome = await autoAdmitVerifiedRows({
        tx, suggestionId, documentId, personId: ctx.personId,
        personSlug: ctx.personSlug, accountId: ctx.uploadedBy,
      });
      console.log(`[s2] ${ctx.shortId} 自动入库 ${outcome.verified.length} 行,`
        + ` 待人工 ${outcome.needsHuman.length} 行, 校验失败 ${outcome.failed.length} 行`);
    }
    });
  }

  return { resultKey: artifactKey };
}

/** 仅供测试。映射是「模型输出 → 可入库建议」的唯一转换点,坏了的表现是静默没有建议。 */
export const stage2Internals = { toPayload, fullTextOf };
