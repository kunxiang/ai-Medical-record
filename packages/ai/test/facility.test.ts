import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL } from '../src/models.js';
import {
  buildFacilityRequest, callFacilityNormalization, FacilityNormalizationError,
} from '../src/facility.js';
import { setTransport, type BetaMessage } from '../src/transport.js';

afterEach(() => setTransport(null));

const facilities = [{ slug: 'f3f7a2', name: '市第一医院', aliases: ['市一院'], city: null, level: null }];
const output = {
  action: 'match_existing' as const,
  existing_facility_slug: 'f3f7a2',
  name: '市第一医院', city: null, level: null, confidence: 0.96, reason: '别名明确对应',
};

function reply(over: Partial<Record<string, unknown>> = {}): BetaMessage {
  return {
    id: 'msg_facility', type: 'message', role: 'assistant', model: MODEL,
    content: [{ type: 'text', text: JSON.stringify(output) }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 30, output_tokens: 20 },
    ...over,
  } as unknown as BetaMessage;
}

describe('facility normalization AI boundary', () => {
  it('稳定 system 只含 prompt，原文与候选在 user message', () => {
    const request = buildFacilityRequest('市一院', facilities);
    expect(request.system).toEqual(expect.arrayContaining([
      expect.objectContaining({ cache_control: { type: 'ephemeral' } }),
    ]));
    expect(JSON.stringify(request.system)).not.toContain('f3f7a2');
    expect(JSON.stringify(request.system)).not.toContain('existing_facilities":[{');
    expect(JSON.stringify(request.messages)).toContain('市一院');
  });

  it('返回可追溯的模型与 prompt 元数据', async () => {
    setTransport(async () => reply({ model: 'facility-fallback' }));
    const result = await callFacilityNormalization('市一院', facilities);
    expect(result.output).toEqual(output);
    expect(result.model).toBe('facility-fallback');
    expect(result.promptVersion).toBe(1);
    expect(result.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refusal 不重试并显式失败', async () => {
    const transport = vi.fn(async () => reply({ stop_reason: 'refusal' }));
    setTransport(transport);
    await expect(callFacilityNormalization('市一院', facilities)).rejects.toBeInstanceOf(FacilityNormalizationError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('不一致的 action/slug 被 schema 拒绝', async () => {
    setTransport(async () => reply({
      content: [{ type: 'text', text: JSON.stringify({ ...output, action: 'create' }) }],
    }));
    await expect(callFacilityNormalization('市一院', facilities)).rejects.toMatchObject({ kind: 'invalid_output' });
  });
});
