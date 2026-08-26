import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  EncounterSuggestionModelOut,
  type EncounterCandidateDocumentT,
  type EncounterCandidatePairT,
  type EncounterSuggestionModelOutT,
} from '@amr/contracts';
import { BETAS, MODEL, S1_EFFORT } from './models.js';
import { getPrompt } from './prompts.js';
import { getTransport, type BetaMessage, type BetaMessageCreateParams } from './transport.js';

export const ENCOUNTER_PROMPT_ID = 'encounter-suggest';
const MAX_TOKENS = 4_000;

export interface EncounterSuggestionResult {
  output: EncounterSuggestionModelOutT;
  model: string;
  promptId: string;
  promptVersion: number;
  promptSha256: string;
}

export class EncounterSuggestionError extends Error {
  constructor(readonly kind: 'refusal' | 'max_tokens' | 'invalid_output' | 'no_text_block', message: string) {
    super(message);
  }
}

let cachedFormat: { type: 'json_schema'; schema: Record<string, unknown> } | null = null;
function outputFormat(): { type: 'json_schema'; schema: Record<string, unknown> } {
  cachedFormat ??= {
    type: 'json_schema',
    schema: zodToJsonSchema(EncounterSuggestionModelOut, {
      target: 'jsonSchema7', $refStrategy: 'none',
    }) as Record<string, unknown>,
  };
  return cachedFormat;
}

export function buildEncounterRequest(
  documents: EncounterCandidateDocumentT[],
  pairs: EncounterCandidatePairT[],
): BetaMessageCreateParams {
  const prompt = getPrompt(ENCOUNTER_PROMPT_ID);
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { format: outputFormat(), effort: S1_EFFORT },
    system: [{ type: 'text', text: prompt.text, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: JSON.stringify({ documents, eligible_pairs: pairs }) }],
    }],
    betas: [...BETAS],
    fallbacks: 'default',
  } as BetaMessageCreateParams;
}

function textOf(message: BetaMessage): string {
  const blocks = (message.content as Array<{ type: string; text?: string }>).filter((block) => block.type === 'text');
  if (blocks.length === 0) throw new EncounterSuggestionError('no_text_block', '响应中没有文本块');
  return blocks.map((block) => block.text ?? '').join('');
}

export async function callEncounterSuggestion(
  documents: EncounterCandidateDocumentT[],
  pairs: EncounterCandidatePairT[],
): Promise<EncounterSuggestionResult> {
  const prompt = getPrompt(ENCOUNTER_PROMPT_ID);
  const response = await getTransport()(buildEncounterRequest(documents, pairs));
  if (response.stop_reason === 'refusal') throw new EncounterSuggestionError('refusal', '模型拒绝就诊归组请求');
  if (response.stop_reason === 'max_tokens') throw new EncounterSuggestionError('max_tokens', '就诊归组输出被截断');
  let output: EncounterSuggestionModelOutT;
  try {
    output = EncounterSuggestionModelOut.parse(JSON.parse(textOf(response)));
  } catch (error) {
    if (error instanceof EncounterSuggestionError) throw error;
    throw new EncounterSuggestionError('invalid_output', `就诊归组输出无效: ${String(error).slice(0, 300)}`);
  }
  return {
    output,
    model: response.model ?? MODEL,
    promptId: prompt.id,
    promptVersion: prompt.version,
    promptSha256: prompt.sha256,
  };
}
