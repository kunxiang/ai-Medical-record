import { zodToJsonSchema } from 'zod-to-json-schema';
import { Stage1Out, type Stage1OutT } from '@amr/contracts';
import { BETAS, MODEL, S1_EFFORT, S1_MAX_TOKENS, S1_MAX_TOKENS_RETRY } from './models.js';
import { getPrompt } from './prompts.js';
import {
  getStreamTransport, getTransport, type BetaMessage, type BetaMessageCreateParams, type Transport,
} from './transport.js';

// spec m2-02 §2/§3/§5 · m2-03。S1:分类 + 元数据 + 全文提取。

export const S1_PROMPT_ID = 's1-classify';

// SDK 的 betaZodOutputFormat 走 `zod/v4` 的 z.toJSONSchema,而本仓库的 schema 是 zod 3 构造的 ——
// 为一个助手函数把整个 workspace 升到 zod 4 不划算。自行生成 JSON Schema,形状与助手一致。
// 生成一次即缓存:format 进入 system 之后的请求体,每次重算既浪费又可能引入不稳定的键序。
let cachedFormat: { type: 'json_schema'; schema: Record<string, unknown> } | null = null;
export function s1OutputFormat(): { type: 'json_schema'; schema: Record<string, unknown> } {
  cachedFormat ??= {
    type: 'json_schema',
    schema: zodToJsonSchema(Stage1Out, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>,
  };
  return cachedFormat;
}

export type S1Failure =
  | { kind: 'refusal'; category: string | null; explanation: string | null }
  | { kind: 'max_tokens' }
  | { kind: 'invalid_output'; detail: string }
  | { kind: 'no_text_block' };

export class S1Error extends Error {
  constructor(readonly failure: S1Failure, message: string) {
    super(message);
  }
}

export interface S1PageInput {
  /** 全局 page_no(审核 #003 A7:分批时也必须是全局的,不是批内序号) */
  pageNo: number;
  /** derived/{slug}/{sid}/ai-NN.webp 的预签名 URL(ADR-050:绝不是 L1 原件) */
  imageUrl: string;
}

export interface S1PdfInput {
  /** 原始 PDF 字节的 base64；PDF 禁止伪装成 image 块。 */
  data: string;
  /** PDF 内部物理页数，用于校验模型不得漏页、重号或跳号。 */
  pageCount: number;
}

export interface S1Result {
  output: Stage1OutT;
  /** 实际服务模型 —— fallback 生效时不等于 MODEL(m2-02 §5.3) */
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  promptVersion: number;
  promptSha256: string;
}

/** 构造请求。抽出来是为了让"图在文字之前""页号是全局的"这两条可被单测直接断言。 */
export function buildS1Request(pages: S1PageInput[], maxTokens: number, promptVersion?: number): BetaMessageCreateParams {
  if (pages.length === 0) throw new Error('S1 至少需要一页');
  const prompt = getPrompt(S1_PROMPT_ID, promptVersion);

  const content = pages
    .slice()
    .sort((a, b) => a.pageNo - b.pageNo)
    .flatMap((p) => [
      // 页号先给出,模型直接采用(prompt 里也写了"不要自行编号")
      { type: 'text' as const, text: `第 ${p.pageNo} 页:` },
      // ★ 图必须在该页文字之后、下一页文字之前;整体上仍是 image-then-text 的结构
      { type: 'image' as const, source: { type: 'url' as const, url: p.imageUrl } },
    ]);
  content.push({ type: 'text' as const, text: '识别这份医疗单据,按 schema 输出。' });

  return {
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { format: s1OutputFormat(), effort: S1_EFFORT },
    // cache_control 只放 system,且 system 内容逐字节稳定 —— 任何随请求变化的东西
    // 放进来都会让缓存静默失效(m2-02 §4.4)
    system: [{ type: 'text', text: prompt.text, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    betas: [...BETAS],
    fallbacks: 'default',
  } as BetaMessageCreateParams;
}

/** PDF 必须作为单个 document 块提交；页号由模型按 PDF 内部物理页序产生。 */
export function buildS1PdfRequest(
  pdf: S1PdfInput,
  maxTokens: number,
  promptVersion?: number,
): BetaMessageCreateParams {
  if (pdf.data.length === 0) throw new Error('PDF 内容不能为空');
  if (!Number.isInteger(pdf.pageCount) || pdf.pageCount < 1 || pdf.pageCount > 600) {
    throw new Error('PDF 页数必须在 1–600 之间');
  }
  const prompt = getPrompt(S1_PROMPT_ID, promptVersion);
  return {
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { format: s1OutputFormat(), effort: S1_EFFORT },
    system: [{ type: 'text', text: prompt.text, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: pdf.data },
      },
      { type: 'text', text: '识别这份 PDF 医疗单据，按 PDF 内部物理页序从 1 开始逐页输出。' },
    ] }],
    betas: [...BETAS],
    fallbacks: 'default',
  } as BetaMessageCreateParams;
}

function textOf(msg: BetaMessage): string {
  const blocks = (msg.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text');
  if (blocks.length === 0) throw new S1Error({ kind: 'no_text_block' }, '响应中没有文本块');
  return blocks.map((b) => b.text ?? '').join('');
}

/** **必须**先看 stop_reason 再读 content(m2-02 §5.1)。 */
function resultOf(res: BetaMessage, maxTokens: number, promptVersion?: number): S1Result {
  const prompt = getPrompt(S1_PROMPT_ID, promptVersion);
  const stop = res.stop_reason;
  if (stop === 'refusal') {
    // stop_details 在 wire 上存在(GA,Opus 4.7+),但 SDK 0.70.1 的 BetaMessage 类型里还没有它。
    // 读不到就记 null —— 缺了分类不影响"转 needs_human 且不重试"这个处置。
    const d = (res as unknown as { stop_details?: { category?: string | null; explanation?: string | null } | null })
      .stop_details;
    throw new S1Error(
      { kind: 'refusal', category: d?.category ?? null, explanation: d?.explanation ?? null },
      `模型拒绝处理该请求(${d?.category ?? '未分类'})`,
    );
  }
  if (stop === 'max_tokens') {
    throw new S1Error({ kind: 'max_tokens' }, `输出被 max_tokens=${maxTokens} 截断`);
  }

  let output: Stage1OutT;
  try {
    output = Stage1Out.parse(JSON.parse(textOf(res)));
  } catch (e) {
    if (e instanceof S1Error) throw e;
    throw new S1Error({ kind: 'invalid_output', detail: String(e).slice(0, 400) }, '输出未通过 schema 校验');
  }

  const u = res.usage;
  return {
    output,
    model: res.model ?? MODEL,
    usage: {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      // 这两项是缓存生效与否的唯一凭证(m2-99 B3),不能丢
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    },
    promptVersion: prompt.version,
    promptSha256: prompt.sha256,
  };
}

/** 单批图像调用。 */
export async function callS1Once(
  pages: S1PageInput[],
  maxTokens = S1_MAX_TOKENS,
  promptVersion?: number,
): Promise<S1Result> {
  return callS1OnceWith(getTransport(), pages, maxTokens, promptVersion);
}

async function callS1OnceWith(
  transport: Transport,
  pages: S1PageInput[],
  maxTokens: number,
  promptVersion?: number,
): Promise<S1Result> {
  return resultOf(
    await transport(buildS1Request(pages, maxTokens, promptVersion)),
    maxTokens,
    promptVersion,
  );
}

/** 单个 PDF document-block 调用，并校验模型输出覆盖每个 PDF 内部物理页。 */
export async function callS1PdfOnce(
  pdf: S1PdfInput,
  maxTokens = S1_MAX_TOKENS,
  promptVersion?: number,
): Promise<S1Result> {
  return callS1PdfOnceWith(getTransport(), pdf, maxTokens, promptVersion);
}

async function callS1PdfOnceWith(
  transport: Transport,
  pdf: S1PdfInput,
  maxTokens: number,
  promptVersion?: number,
): Promise<S1Result> {
  const result = resultOf(
    await transport(buildS1PdfRequest(pdf, maxTokens, promptVersion)),
    maxTokens,
    promptVersion,
  );
  const pageNos = result.output.pages.map((page) => page.page_no);
  const expected = Array.from({ length: pdf.pageCount }, (_, index) => index + 1);
  if (pageNos.length !== expected.length || pageNos.some((pageNo, index) => pageNo !== expected[index])) {
    throw new S1Error(
      { kind: 'invalid_output', detail: `PDF 页号期望 ${expected.join(',')}，实际 ${pageNos.join(',')}` },
      'PDF 输出页号与内部物理页序不一致',
    );
  }
  return result;
}

/** 带一次 max_tokens 提额重试(m2-02 §5.4)。refusal 不重试 —— 同一输入只会再被拒一次。 */
export async function callS1(pages: S1PageInput[], promptVersion?: number): Promise<S1Result> {
  try {
    return await callS1Once(pages, S1_MAX_TOKENS, promptVersion);
  } catch (e) {
    if (e instanceof S1Error && e.failure.kind === 'max_tokens') {
      return callS1OnceWith(getStreamTransport(), pages, S1_MAX_TOKENS_RETRY, promptVersion);
    }
    throw e;
  }
}

export async function callS1Pdf(pdf: S1PdfInput, promptVersion?: number): Promise<S1Result> {
  try {
    return await callS1PdfOnce(pdf, S1_MAX_TOKENS, promptVersion);
  } catch (e) {
    if (e instanceof S1Error && e.failure.kind === 'max_tokens') {
      return callS1PdfOnceWith(getStreamTransport(), pdf, S1_MAX_TOKENS_RETRY, promptVersion);
    }
    throw e;
  }
}
