import { and, eq, sql } from 'drizzle-orm';
import { S1Artifact, Stage1Out, type Stage1OutT } from '@amr/contracts';
import { MAX_IMAGES_PER_REQUEST, S1Error, assertBatchPages, callS1, getPrompt, mergeBatches, planBatches, S1_PROMPT_ID, type S1PageInput } from '@amr/ai';
import { buildKey, canonicalJson, serverTimestamp } from '@amr/storage';
import { db } from '../db/client.js';
import { document, documentPage, person } from '../db/schema.js';
import { ensureDerivative } from '../derivatives.js';
import { getObjectText, presignGetKey, putWorm } from '../s3.js';
import { normalizeName, personCheckOf } from '../person-check.js';
import type { JobFailure } from './queue.js';

// spec m2-03。S1:分类 + 元数据 + 全文提取。

export class Stage1Failure extends Error {
  constructor(readonly terminal: 'needs_human' | 'failed' | 'unsupported' | null, readonly detail: JobFailure) {
    super(detail.message);
  }
}

interface DocContext {
  documentId: string; shortId: string; personId: string; personSlug: string;
  displayName: string; namePinyin: string | null;
  pages: Array<{ pageNo: number; storageKey: string; mimeType: string }>;
}

async function loadContext(documentId: string): Promise<DocContext | null> {
  const rows = await db
    .select({
      documentId: document.id, shortId: document.shortId, personId: document.personId,
      personSlug: person.slug, displayName: person.displayName, namePinyin: person.namePinyin,
      pageNo: documentPage.pageNo, storageKey: documentPage.storageKey, mimeType: documentPage.mimeType,
    })
    .from(documentPage)
    .innerJoin(document, eq(document.id, documentPage.documentId))
    .innerJoin(person, eq(person.id, document.personId))
    .where(eq(documentPage.documentId, documentId))
    .orderBy(documentPage.pageNo);
  const first = rows[0];
  if (!first) return null;
  return {
    documentId: first.documentId, shortId: first.shortId, personId: first.personId,
    personSlug: first.personSlug, displayName: first.displayName, namePinyin: first.namePinyin,
    pages: rows.map((r) => ({ pageNo: r.pageNo, storageKey: r.storageKey, mimeType: r.mimeType })),
  };
}

/** 送进模型的必须是 ai 派生物,不是 L1 原件(ADR-050)。
 *  Claude 不解析图片元数据 —— 原件的 EXIF Orientation 会被完全忽略,
 *  横躺的单据进模型不会报错,只表现为"提取质量莫名其妙地差"。 */
async function prepareImages(ctx: DocContext): Promise<S1PageInput[]> {
  const out: S1PageInput[] = [];
  for (const p of ctx.pages) {
    const { key } = await ensureDerivative({
      personSlug: ctx.personSlug, docShortId: ctx.shortId, pageNo: p.pageNo,
      variant: 'ai', sourceKey: p.storageKey, mimeType: p.mimeType,
    });
    // 预签名有效期 ≥900s(m2-02 §3.1):Anthropic 服务端要去 fetch 它
    out.push({ pageNo: p.pageNo, imageUrl: await presignGetKey(key, 900) });
  }
  return out;
}

/** 分批调用并按确定性规则合并(m2-03 §5)。>20 图会触发更严的逐图尺寸限制。 */
async function runS1(images: S1PageInput[]): Promise<{ output: Stage1OutT; model: string; usage: Record<string, number>; batches: number; promptVersion: number; promptSha256: string }> {
  const batches = planBatches(images.map((i) => i.pageNo));
  const results = [];
  let model = '', usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  for (const pageNos of batches) {
    const slice = images.filter((i) => pageNos.includes(i.pageNo));
    const r = await callS1(slice);
    assertBatchPages(pageNos, r.output);      // 模型自行编号是最隐蔽的失败(审核 #003 A7)
    results.push(r.output);
    model = r.model;
    for (const k of Object.keys(usage) as Array<keyof typeof usage>) usage[k] += r.usage[k];
  }
  const prompt = getPrompt(S1_PROMPT_ID);
  return {
    output: mergeBatches(results), model, usage, batches: batches.length,
    promptVersion: prompt.version, promptSha256: prompt.sha256,
  };
}

export async function handleStage1(documentId: string): Promise<{ resultKey: string }> {
  const ctx = await loadContext(documentId);
  if (!ctx) throw new Stage1Failure('failed', { stage: 'load', code: 'document_not_found', message: `文档不存在: ${documentId}` });

  // PDF 走 document 块(m2-02 §3.5);M2 暂不实现,记 unsupported 而不是静默跳过
  if (ctx.pages.some((p) => p.mimeType === 'application/pdf')) {
    throw new Stage1Failure('unsupported', { stage: 's1', code: 'pdf_not_supported', message: 'PDF 的 document 块路径待实现' });
  }

  const prompt = getPrompt(S1_PROMPT_ID);
  const artifactKey = buildKey.extraction({
    personSlug: ctx.personSlug, docShortId: ctx.shortId, stage: 's1', promptVersion: prompt.version,
  });

  // 412 路径(审核 #004 B-12):工件已存在 = "PUT 成功但 DB commit 前崩了"的重跑。
  // 工件是好的,重新调模型纯属浪费。
  const existing = await getObjectText(artifactKey);
  let artifact;
  if (existing) {
    artifact = S1Artifact.parse(JSON.parse(existing.text));
  } else {
    const images = await prepareImages(ctx);
    let ran;
    try {
      ran = await runS1(images);
    } catch (e: unknown) {
      if (e instanceof S1Error) {
        const f = e.failure;
        if (f.kind === 'refusal') {
          throw new Stage1Failure('needs_human', { stage: 's1', code: 'refusal', message: e.message, category: f.category });
        }
        if (f.kind === 'max_tokens' || f.kind === 'invalid_output' || f.kind === 'no_text_block') {
          throw new Stage1Failure('needs_human', { stage: 's1', code: f.kind, message: e.message });
        }
      }
      throw e;   // 其余交给 worker 按可重试处理
    }
    artifact = S1Artifact.parse({
      schema_version: '1.0', stage: 's1',
      document_short_id: ctx.shortId, produced_at: serverTimestamp(),
      model: ran.model, prompt_id: prompt.id, prompt_version: ran.promptVersion,
      prompt_sha256: ran.promptSha256, effort: 'medium', batches: ran.batches,
      usage: ran.usage, output: Stage1Out.parse(ran.output),
    });
    await putWorm(artifactKey, canonicalJson(artifact), 'application/json');
  }

  const out = artifact.output;
  // 归人对账:确定性比对,**禁止**改 person_id,**禁止**写任何 L1 人工层列(m2-05 §1)
  const check = personCheckOf(out.patient_name, ctx.displayName, ctx.namePinyin);

  await db
    .update(document)
    .set({
      docType: out.doc_type,
      docTypeConfidence: String(out.doc_type_confidence),
      sampledOn: out.sampled_on,
      reportedOn: out.reported_on,
      eventTime: out.event_at ? new Date(out.event_at) : null,
      // ★ S1 读到了报告上印的时分,但**不知道那是采集时刻还是报告时刻**。
      //   而 event_time_source 存在的理由正是 docs/03 §239:"否则时间轴的精度无从判断"
      //   —— 影像的报告时间晚于实际检查,化验的采集时刻就是事件本身。
      //   在 S1 能分辨之前,如实写 s1_unspecified,而不是编一个看起来精确的值(设计债 D22)。
      eventTimeSource: out.event_at ? 's1_unspecified' : null,
      departmentRaw: out.department_raw,
      personCheck: check,
      s1ArtifactKey: artifactKey,
      s1PromptVersion: artifact.prompt_version,
    })
    .where(eq(document.id, documentId));

  return { resultKey: artifactKey };
}

export const stage1Internals = { normalizeName, and, sql };
