// spec m2-02 §2/§3/§5:请求形状与失败处置。用注入的 transport 断言工程正确性,
// 不断言模型输出 —— 后者是 C 组的事(m2-99 §0)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Stage1OutT } from '@amr/contracts';
import { MODEL } from '../src/models.js';
import {
  buildS1PdfRequest, buildS1Request, callS1, callS1Once, callS1PdfOnce, S1Error,
} from '../src/stage1.js';
import { setStreamTransport, setTransport, type BetaMessage } from '../src/transport.js';

afterEach(() => setTransport(null));

const OUT: Stage1OutT = {
  doc_type: 'lab_report', doc_type_confidence: 0.9,
  patient_name: '张三', patient_sex: 'male', patient_age_text: '3岁', patient_identifiers: [],
  facility_name_raw: '市一院', department_raw: '儿科',
  sampled_on: '2024-03-15', reported_on: '2024-03-15', event_at: null,
  summary: '血常规', pages: [{ page_no: 1, page_label: null, page_index: null, page_total: null, full_text: 'x' }],
  pii_spans: [], unmodeled: [], boundary_hint: null,
};

function reply(over: Partial<Record<string, unknown>> = {}): BetaMessage {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: MODEL,
    content: [{ type: 'text', text: JSON.stringify(OUT) }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    ...over,
  } as unknown as BetaMessage;
}

const P = [{ pageNo: 21, imageUrl: 'https://s3/ai-21.webp' }, { pageNo: 22, imageUrl: 'https://s3/ai-22.webp' }];

describe('buildS1Request(m2-02 §2/§3)', () => {
  const req = buildS1Request(P, 16000);
  const content = (req.messages[0]!.content as Array<{ type: string; text?: string; source?: { url?: string } }>);

  it('每页图前是全局页号,不是批内序号(审核 #003 A7)', () => {
    expect(content[0]).toMatchObject({ type: 'text', text: '第 21 页:' });
    expect(content[2]).toMatchObject({ type: 'text', text: '第 22 页:' });
  });

  it('图像块引用 ai 派生物,不是 L1 原件(ADR-050)', () => {
    const imgs = content.filter((c) => c.type === 'image');
    expect(imgs).toHaveLength(2);
    expect(imgs.every((i) => /ai-\d{2}\.webp$/.test(i.source?.url ?? ''))).toBe(true);
    expect(content.some((c) => c.type === 'image' && 'data' in (c.source ?? {}))).toBe(false);  // 禁止 base64
  });

  it('cache_control 只在 system 上,且 system 内容不含易变量', () => {
    const sys = req.system as Array<{ text: string; cache_control?: unknown }>;
    expect(sys).toHaveLength(1);
    expect(sys[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[0]!.text).not.toMatch(/第 2[12] 页|https:\/\//);   // 页号与 URL 必须在 messages 里
    expect(content.some((c) => (c as { cache_control?: unknown }).cache_control)).toBe(false);
  });

  it('启用服务端 fallback,且不传被 Opus 5 拒绝的参数', () => {
    expect(req.betas).toContain('server-side-fallback-2026-07-01');
    expect((req as Record<string, unknown>)['fallbacks']).toBe('default');
    expect((req as Record<string, unknown>)['thinking']).toBeUndefined();       // 省略 = adaptive
    expect((req as Record<string, unknown>)['temperature']).toBeUndefined();    // Opus 5 上会 400
  });

  it('页序乱给也按 page_no 升序排列', () => {
    const r = buildS1Request([P[1]!, P[0]!], 16000);
    const c = r.messages[0]!.content as Array<{ text?: string }>;
    expect(c[0]!.text).toBe('第 21 页:');
  });
});

describe('callS1 的失败处置(m2-02 §5)', () => {
  it('成功路径带回实际服务模型与 usage', async () => {
    // 用一个明显假的名字:这条断言检的是"响应里的 model 被原样带回",
    // 与具体是哪个 fallback 模型无关(也就不必在测试里钉死一个真模型名)
    setTransport(async () => reply({ model: 'some-fallback-model' }));
    const r = await callS1Once(P);
    expect(r.model).toBe('some-fallback-model');
    expect(r.usage.cache_read_input_tokens).toBe(900);
    expect(r.promptVersion).toBe(2);
  });

  it('refusal ⇒ 终态,记录 category,且**不重试**', async () => {
    const t = vi.fn(async () => reply({
      stop_reason: 'refusal', stop_details: { category: 'bio', explanation: '拒绝理由' },
    }));
    setTransport(t);
    await expect(callS1(P)).rejects.toThrow(S1Error);
    expect(t).toHaveBeenCalledTimes(1);          // ★ 同一输入重试只会再被拒一次
    await callS1(P).catch((e: S1Error) => {
      expect(e.failure).toMatchObject({ kind: 'refusal', category: 'bio' });
    });
  });

  it('max_tokens ⇒ 以 32000 重试恰一次', async () => {
    const regular = vi.fn(async () => reply({ stop_reason: 'max_tokens' }));
    const streamed = vi.fn(async () => reply());
    setTransport(regular);
    setStreamTransport(streamed);
    const r = await callS1(P);
    expect(regular).toHaveBeenCalledTimes(1);
    expect(regular.mock.calls[0]![0].max_tokens).toBe(16000);
    expect(streamed).toHaveBeenCalledTimes(1);
    expect(streamed.mock.calls[0]![0].max_tokens).toBe(32000);
    expect(r.output.doc_type).toBe('lab_report');
  });

  it('两次都 max_tokens ⇒ 抛出,不无限重试', async () => {
    const t = vi.fn(async () => reply({ stop_reason: 'max_tokens' }));
    setTransport(t);
    await expect(callS1(P)).rejects.toThrow(S1Error);
    expect(t).toHaveBeenCalledTimes(2);
  });

  it('输出不合 schema ⇒ invalid_output', async () => {
    setTransport(async () => reply({ content: [{ type: 'text', text: '{"doc_type":"不存在的类型"}' }] }));
    await callS1Once(P).catch((e: S1Error) => expect(e.failure.kind).toBe('invalid_output'));
  });

  it('未知键也被拒(strict)', async () => {
    setTransport(async () => reply({
      content: [{ type: 'text', text: JSON.stringify({ ...OUT, 未知字段: 1 }) }],
    }));
    await expect(callS1Once(P)).rejects.toThrow(S1Error);
  });

  it('响应无文本块 ⇒ no_text_block,不静默返回空', async () => {
    setTransport(async () => reply({ content: [] }));
    await callS1Once(P).catch((e: S1Error) => expect(e.failure.kind).toBe('no_text_block'));
  });
});

describe('PDF document-block(m2-99 A14b/A26)', () => {
  const pdf = { data: 'JVBERi0xLjQK', pageCount: 3 };

  it('PDF 使用单个 base64 document 块，不走 image 块', () => {
    const request = buildS1PdfRequest(pdf, 16000);
    const content = request.messages[0]!.content as Array<{
      type: string;
      source?: { type?: string; media_type?: string; data?: string };
    }>;
    expect(content[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdf.data },
    });
    expect(content.some((block) => block.type === 'image')).toBe(false);
  });

  it('接受完整的 PDF 内部页序 1/2/3', async () => {
    setTransport(async () => reply({
      content: [{ type: 'text', text: JSON.stringify({
        ...OUT,
        pages: [1, 2, 3].map((pageNo) => ({
          page_no: pageNo, page_label: null, page_index: null,
          page_total: 3, full_text: `p${pageNo}`,
        })),
      }) }],
    }));
    const result = await callS1PdfOnce(pdf);
    expect(result.output.pages.map((page) => page.page_no)).toEqual([1, 2, 3]);
  });

  it('PDF 漏页或重号进入 invalid_output', async () => {
    setTransport(async () => reply({
      content: [{ type: 'text', text: JSON.stringify({
        ...OUT,
        pages: [OUT.pages[0], { ...OUT.pages[0], page_no: 3 }],
      }) }],
    }));
    await callS1PdfOnce(pdf).catch((error: S1Error) => {
      expect(error.failure.kind).toBe('invalid_output');
    });
  });
});
