import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, BetaMessageCreateParams, Transport } from './transport.js';

const RESPONSES_URL = 'https://api.deepseek.com/responses';
const ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
const TIMEOUT_MS = 600_000;

type JsonRecord = Record<string, unknown>;

export class DeepSeekTransportError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message);
  }
}

function requiredApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new DeepSeekTransportError(null, '缺少环境变量 DEEPSEEK_API_KEY');
  return key;
}

function contentBlocks(params: BetaMessageCreateParams): JsonRecord[] {
  return params.messages.flatMap((message) => {
    if (typeof message.content === 'string') {
      return [{ type: 'input_text', text: message.content }];
    }
    return (message.content as unknown as JsonRecord[]).map((block) => {
      if (block.type === 'text') return { type: 'input_text', text: block.text };
      if (block.type === 'image') {
        const source = block.source as JsonRecord;
        if (source.type === 'url') return { type: 'input_image', image_url: source.url };
        if (source.type === 'base64') {
          return { type: 'input_image', image_url: `data:${String(source.media_type)};base64,${String(source.data)}` };
        }
      }
      throw new DeepSeekTransportError(null, `DeepSeek Responses 不支持内容块 ${String(block.type)}`);
    });
  });
}

function instructionsOf(params: BetaMessageCreateParams): string {
  if (typeof params.system === 'string') return params.system;
  return ((params.system ?? []) as unknown as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n\n');
}

function outputSchemaOf(params: BetaMessageCreateParams): JsonRecord | null {
  const config = params.output_config as unknown as { format?: { type?: string; schema?: JsonRecord } } | undefined;
  return config?.format?.type === 'json_schema' && config.format.schema ? config.format.schema : null;
}

export function isPdfRequest(params: BetaMessageCreateParams): boolean {
  return params.messages.some((message) => Array.isArray(message.content)
    && (message.content as unknown as JsonRecord[]).some((block) => block.type === 'document'));
}

/** 纯函数：便于断言不会把 PDF 静默丢给不支持文件的 Responses 路径。 */
export function buildDeepSeekResponsesRequest(params: BetaMessageCreateParams): JsonRecord {
  if (isPdfRequest(params)) throw new DeepSeekTransportError(null, 'PDF 必须走 DeepSeek Anthropic document 路径');
  const schema = outputSchemaOf(params);
  const effort = (params.output_config as unknown as { effort?: string } | undefined)?.effort;
  return {
    model: params.model,
    instructions: instructionsOf(params),
    input: [{ role: 'user', content: contentBlocks(params) }],
    ...(schema ? { text: { format: { type: 'json_schema', name: 'amr_structured_output', schema } } } : {}),
    // DeepSeek Responses 没有 medium；S1 是抄写任务，映射到 low 避免思考 token 挤占长文本输出。
    reasoning: { effort: effort === 'max' || effort === 'high' ? effort : 'low' },
    max_output_tokens: params.max_tokens,
  };
}

interface DeepSeekResponsesResult {
  id?: string;
  status?: string;
  model?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string; type?: string; code?: string } | null;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

export function deepSeekResponseToBetaMessage(response: DeepSeekResponsesResult, requestedModel: string): BetaMessage {
  const text = (response.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text ?? '')
    .join('');
  const refused = (response.output ?? []).some((item) =>
    (item.content ?? []).some((content) => content.type === 'refusal'));
  const stopReason = refused || response.incomplete_details?.reason === 'content_filter'
    ? 'refusal'
    : response.incomplete_details?.reason === 'max_output_tokens'
      ? 'max_tokens'
      : 'end_turn';
  return {
    id: response.id ?? 'deepseek-response',
    type: 'message',
    role: 'assistant',
    model: response.model ?? requestedModel,
    content: text ? [{ type: 'text', text }] : [],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      cache_read_input_tokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as BetaMessage;
}

async function callResponses(params: BetaMessageCreateParams): Promise<BetaMessage> {
  const response = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${requiredApiKey()}`, 'content-type': 'application/json' },
    body: JSON.stringify(buildDeepSeekResponsesRequest(params)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.json() as DeepSeekResponsesResult;
  if (!response.ok || body.error) {
    throw new DeepSeekTransportError(
      response.status,
      `DeepSeek Responses ${response.status}: ${body.error?.message ?? body.error?.type ?? 'unknown error'}`.slice(0, 800),
    );
  }
  return deepSeekResponseToBetaMessage(body, params.model);
}

let pdfClient: Anthropic | null = null;
function getPdfClient(): Anthropic {
  pdfClient ??= new Anthropic({ apiKey: requiredApiKey(), baseURL: ANTHROPIC_BASE_URL, timeout: TIMEOUT_MS });
  return pdfClient;
}

export function addPdfSchemaInstruction(params: BetaMessageCreateParams): BetaMessageCreateParams {
  const schema = outputSchemaOf(params);
  if (!schema) return params;
  const instruction = [
    '严格返回满足下列 JSON Schema 的 JSON 对象。所有 required 字段必须存在。',
    'doc_type 无法判断时必须使用字符串 unknown，绝不能使用 null。不要输出 schema 之外的字段。',
    `JSON Schema:\n${JSON.stringify(schema)}`,
  ].join('\n');
  const system = typeof params.system === 'string'
    ? [{ type: 'text' as const, text: params.system }, { type: 'text' as const, text: instruction }]
    : [...(params.system ?? []), { type: 'text' as const, text: instruction }];
  return { ...params, system } as BetaMessageCreateParams;
}

async function callPdf(params: BetaMessageCreateParams): Promise<BetaMessage> {
  return getPdfClient().beta.messages.create(addPdfSchemaInstruction(params));
}

export const deepSeekTransport: Transport = async (params) =>
  isPdfRequest(params) ? callPdf(params) : callResponses(params);
