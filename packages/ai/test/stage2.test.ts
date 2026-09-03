import { afterEach, describe, expect, it } from 'vitest';
import { MODEL } from '../src/models.js';
import { buildS2Request, callS2, Stage2Error } from '../src/stage2.js';
import { setTransport, type BetaMessage } from '../src/transport.js';

afterEach(() => setTransport(null));

const FULL_TEXT = [
  '龙岗区第二人民医院血液细胞检验报告单',
  '姓名：向坤 性别：男 年龄：3岁 样本编号：40',
  '1 白细胞(WBC) 6.11 3.50-9.50 10^9/L | 18 平均血红蛋白含量(MCH) 30.1 27.0-34.0 pg',
].join('\n');

const output = {
  rows: [
    { local_name: '白细胞(WBC)', value_raw: '6.11', unit_raw: '10^9/L', ref_text: '3.50-9.50', abnormal_flag_raw: null },
    { local_name: '平均血红蛋白含量(MCH)', value_raw: '30.1', unit_raw: 'pg', ref_text: '27.0-34.0', abnormal_flag_raw: null },
  ],
};

function reply(over: Partial<Record<string, unknown>> = {}): BetaMessage {
  return {
    id: 'msg_s2', type: 'message', role: 'assistant', model: MODEL,
    content: [{ type: 'text', text: JSON.stringify(output) }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 400, output_tokens: 120 },
    ...over,
  } as unknown as BetaMessage;
}

describe('stage 2 化验结构化的 AI 边界', () => {
  it('system 只含 prompt，单据文本在 user message', () => {
    const request = buildS2Request(FULL_TEXT);
    expect(request.system).toEqual(expect.arrayContaining([
      expect.objectContaining({ cache_control: { type: 'ephemeral' } }),
    ]));
    // 断言逐份文档的内容不进 system —— system 带 ephemeral 缓存,
    // 混入单据内容会让缓存逐份失效,也会把患者信息塞进可缓存块。
    expect(JSON.stringify(request.system)).not.toContain('向坤');
    expect(JSON.stringify(request.system)).not.toContain('6.11');
    expect(JSON.stringify(request.messages)).toContain('向坤');
  });

  it('不再送图 —— Stage 2 的输入只有文本块', () => {
    const request = buildS2Request(FULL_TEXT);
    const blocks = JSON.stringify(request.messages);
    expect(blocks).not.toContain('"type":"image"');
    expect(blocks).not.toContain('input_image');
  });

  it('max_tokens 与 S1 同档 —— 100 行输出不能被截断', () => {
    expect(buildS2Request(FULL_TEXT).max_tokens).toBe(16_000);
  });

  it('返回可追溯的模型与 prompt 元数据', async () => {
    setTransport(async () => reply({ model: 's2-fallback' }));
    const result = await callS2(FULL_TEXT);
    expect(result.output).toEqual(output);
    expect(result.model).toBe('s2-fallback');
    expect(result.promptId).toBe('s2-lab-observations');
    expect(result.promptVersion).toBe(1);
    expect(result.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('截断按 max_tokens 报错，不当成有效结果', async () => {
    setTransport(async () => reply({ stop_reason: 'max_tokens' }));
    await expect(callS2(FULL_TEXT)).rejects.toThrow(Stage2Error);
  });

  it('不合 schema 的输出一律拒收 —— 模型产出跨信任边界必须校验', async () => {
    setTransport(async () => reply({
      content: [{ type: 'text', text: JSON.stringify({ rows: [{ local_name: '白细胞' }] }) }],
    }));
    await expect(callS2(FULL_TEXT)).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('空表是合法结果，不报错', async () => {
    setTransport(async () => reply({ content: [{ type: 'text', text: JSON.stringify({ rows: [] }) }] }));
    await expect(callS2(FULL_TEXT)).resolves.toMatchObject({ output: { rows: [] } });
  });
});
