import { describe, expect, it } from 'vitest';
import {
  addPdfSchemaInstruction,
  buildDeepSeekResponsesRequest,
  deepSeekResponseToBetaMessage,
  isPdfRequest,
} from '../src/deepseek-transport.js';
import { buildS1PdfRequest, buildS1Request } from '../src/stage1.js';

describe('DeepSeek transport adapter', () => {
  it('图片请求走 Responses API，保留 URL 并携带严格 schema', () => {
    const source = buildS1Request([{ pageNo: 7, imageUrl: 'https://s3.example/ai-07.webp' }], 16_000);
    expect(isPdfRequest(source)).toBe(false);

    const request = buildDeepSeekResponsesRequest(source) as {
      input: Array<{ content: Array<{ type: string; image_url?: string; text?: string }> }>;
      text: { format: { type: string; name: string; schema: Record<string, unknown> } };
      reasoning: { effort: string };
      max_output_tokens: number;
    };
    expect(request.input[0]!.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'input_image', image_url: 'https://s3.example/ai-07.webp' }),
      expect.objectContaining({
        type: 'input_text',
        text: expect.stringContaining('第 7 页'),
      }),
    ]));
    expect(request.text.format).toMatchObject({ type: 'json_schema', name: 'amr_structured_output' });
    expect(request.text.format.schema).toHaveProperty('properties.doc_type');
    expect(request.reasoning.effort).toBe('low');
    expect(request.max_output_tokens).toBe(16_000);
  });

  it('PDF 不会被静默映射为 Responses 文件，Anthropic 路径补全 schema 约束', () => {
    const source = buildS1PdfRequest({ data: 'JVBERi0xLjQK', pageCount: 1 }, 16_000);
    expect(isPdfRequest(source)).toBe(true);
    expect(() => buildDeepSeekResponsesRequest(source)).toThrow(/PDF/);

    const mapped = addPdfSchemaInstruction(source);
    const system = mapped.system as Array<{ type: string; text: string }>;
    expect(system.at(-1)?.text).toContain('doc_type 无法判断时必须使用字符串 unknown');
    expect(system.at(-1)?.text).toContain('"doc_type"');
  });

  it('Responses 截断和 token usage 映射回既有 Anthropic 合约', () => {
    const message = deepSeekResponseToBetaMessage({
      id: 'resp_1', status: 'incomplete', model: 'deepseek-v4-flash-vision-exp',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      usage: { input_tokens: 120, output_tokens: 80, input_tokens_details: { cached_tokens: 100 } },
    }, 'requested-model');
    expect(message.stop_reason).toBe('max_tokens');
    expect(message.model).toBe('deepseek-v4-flash-vision-exp');
    expect(message.content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
    expect(message.usage).toMatchObject({
      input_tokens: 120, output_tokens: 80, cache_read_input_tokens: 100,
    });
  });
});
