import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  FacilityNormalizationModelOut,
  type FacilityNormalizationModelOutT,
} from '@amr/contracts';
import { BETAS, MODEL, S1_EFFORT } from './models.js';
import { getPrompt } from './prompts.js';
import { getTransport, type BetaMessage, type BetaMessageCreateParams } from './transport.js';

export const FACILITY_PROMPT_ID = 'facility-normalize';
const MAX_TOKENS = 2_000;

export interface FacilityCandidateInput {
  slug: string;
  name: string;
  aliases: string[];
  city: string | null;
  level: string | null;
}

export interface FacilityNormalizationResult {
  output: FacilityNormalizationModelOutT;
  model: string;
  promptId: string;
  promptVersion: number;
  promptSha256: string;
}

export class FacilityNormalizationError extends Error {
  constructor(readonly kind: 'refusal' | 'max_tokens' | 'invalid_output' | 'no_text_block', message: string) {
    super(message);
  }
}

let cachedFormat: { type: 'json_schema'; schema: Record<string, unknown> } | null = null;
function outputFormat(): { type: 'json_schema'; schema: Record<string, unknown> } {
  cachedFormat ??= {
    type: 'json_schema',
    schema: zodToJsonSchema(FacilityNormalizationModelOut, {
      target: 'jsonSchema7', $refStrategy: 'none',
    }) as Record<string, unknown>,
  };
  return cachedFormat;
}

export function buildFacilityRequest(
  rawName: string,
  facilities: FacilityCandidateInput[],
): BetaMessageCreateParams {
  const prompt = getPrompt(FACILITY_PROMPT_ID);
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { format: outputFormat(), effort: S1_EFFORT },
    system: [{ type: 'text', text: prompt.text, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: JSON.stringify({ raw_name: rawName, existing_facilities: facilities }),
      }],
    }],
    betas: [...BETAS],
    fallbacks: 'default',
  } as BetaMessageCreateParams;
}

function textOf(message: BetaMessage): string {
  const blocks = (message.content as Array<{ type: string; text?: string }>).filter((block) => block.type === 'text');
  if (blocks.length === 0) throw new FacilityNormalizationError('no_text_block', '响应中没有文本块');
  return blocks.map((block) => block.text ?? '').join('');
}

export async function callFacilityNormalization(
  rawName: string,
  facilities: FacilityCandidateInput[],
): Promise<FacilityNormalizationResult> {
  const prompt = getPrompt(FACILITY_PROMPT_ID);
  const response = await getTransport()(buildFacilityRequest(rawName, facilities));
  if (response.stop_reason === 'refusal') {
    throw new FacilityNormalizationError('refusal', '模型拒绝机构归一请求');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new FacilityNormalizationError('max_tokens', '机构归一输出被截断');
  }
  let output: FacilityNormalizationModelOutT;
  try {
    output = FacilityNormalizationModelOut.parse(JSON.parse(textOf(response)));
  } catch (error) {
    if (error instanceof FacilityNormalizationError) throw error;
    throw new FacilityNormalizationError('invalid_output', `机构归一输出无效: ${String(error).slice(0, 300)}`);
  }
  return {
    output,
    model: response.model ?? MODEL,
    promptId: prompt.id,
    promptVersion: prompt.version,
    promptSha256: prompt.sha256,
  };
}
