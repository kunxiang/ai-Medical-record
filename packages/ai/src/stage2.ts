import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  Stage2ObservationModelOut,
  type Stage2ObservationModelOutT,
} from '@amr/contracts';
import { BETAS, MODEL, S1_EFFORT, S1_MAX_TOKENS } from './models.js';
import { getPrompt } from './prompts.js';
import { getTransport, type BetaMessage, type BetaMessageCreateParams } from './transport.js';

// spec m5-01。Stage 2 的输入是 **Stage 1 已经提取好的 full_text**,不再看图。
//
// 为什么不再跑一次视觉:S1 的 full_text 已经把整张表(项目名/结果/参考范围/单位)读全了,
// 再送一次图只是把同样的内容用图像 token 重买一遍。代价换来的唯一增量是 source_bbox,
// 而现阶段没有证据说明值得为它付双倍图像成本(见 ADR-053)。
//
// 也不用手写解析器:full_text 的排版逐家医院不同(本仓实测的那张就是 `|` 分隔的双栏),
// 用正则去追每家医院会退化成按症状打补丁。

export const S2_PROMPT_ID = 's2-lab-observations';

export interface Stage2Result {
  output: Stage2ObservationModelOutT;
  model: string;
  promptId: string;
  promptVersion: number;
  promptSha256: string;
}

export class Stage2Error extends Error {
  constructor(
    readonly kind: 'refusal' | 'max_tokens' | 'invalid_output' | 'no_text_block',
    message: string,
  ) {
    super(message);
  }
}

let cachedFormat: { type: 'json_schema'; schema: Record<string, unknown> } | null = null;
function outputFormat(): { type: 'json_schema'; schema: Record<string, unknown> } {
  cachedFormat ??= {
    type: 'json_schema',
    schema: zodToJsonSchema(Stage2ObservationModelOut, {
      target: 'jsonSchema7', $refStrategy: 'none',
    }) as Record<string, unknown>,
  };
  return cachedFormat;
}

export function buildS2Request(fullText: string): BetaMessageCreateParams {
  const prompt = getPrompt(S2_PROMPT_ID);
  return {
    model: MODEL,
    // 与 S1 同档:100 行 × 5 字段的 JSON 可以逼近上限,而截断是 max_tokens 硬失败。
    // 2026-08-30 的实测里 8000 就把 S1 截断过一次,不重蹈。
    max_tokens: S1_MAX_TOKENS,
    output_config: { format: outputFormat(), effort: S1_EFFORT },
    system: [{ type: 'text', text: prompt.text, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: JSON.stringify({ full_text: fullText }) }],
    }],
    betas: [...BETAS],
    fallbacks: 'default',
  } as BetaMessageCreateParams;
}

function textOf(message: BetaMessage): string {
  const blocks = (message.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === 'text');
  if (blocks.length === 0) throw new Stage2Error('no_text_block', '响应中没有文本块');
  return blocks.map((block) => block.text ?? '').join('');
}

export async function callS2(fullText: string): Promise<Stage2Result> {
  const prompt = getPrompt(S2_PROMPT_ID);
  const response = await getTransport()(buildS2Request(fullText));
  if (response.stop_reason === 'refusal') {
    throw new Stage2Error('refusal', '模型拒绝化验结构化请求');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Stage2Error('max_tokens', '化验结构化输出被截断');
  }
  let output: Stage2ObservationModelOutT;
  try {
    output = Stage2ObservationModelOut.parse(JSON.parse(textOf(response)));
  } catch (error) {
    if (error instanceof Stage2Error) throw error;
    throw new Stage2Error('invalid_output', `化验结构化输出无效: ${String(error).slice(0, 300)}`);
  }
  return {
    output,
    model: response.model ?? MODEL,
    promptId: prompt.id,
    promptVersion: prompt.version,
    promptSha256: prompt.sha256,
  };
}
