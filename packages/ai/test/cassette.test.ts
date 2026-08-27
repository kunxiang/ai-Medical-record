import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Stage1OutT } from '@amr/contracts';
import {
  assertNoCassettePii, cassetteFingerprint, cassetteTransport,
} from '../src/cassette.js';
import { buildS1Request } from '../src/stage1.js';
import type { BetaMessage } from '../src/transport.js';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function reply(): BetaMessage {
  const fullText = '张三 手机13800138000 北京医院';
  const start = fullText.indexOf('13800138000');
  const output: Stage1OutT = {
    doc_type: 'lab_report', doc_type_confidence: 0.9,
    patient_name: '张三', patient_sex: 'male', patient_age_text: null,
    patient_identifiers: [], facility_name_raw: '北京医院', department_raw: null,
    sampled_on: null, reported_on: null, event_at: null, summary: '合成回放',
    pages: [{ page_no: 1, page_label: null, page_index: null, page_total: null, full_text: fullText }],
    pii_spans: [{ page_no: 1, kind: 'phone', start, end: start + 11 }],
    unmodeled: [], boundary_hint: null,
  };
  return {
    id: 'cassette-test', type: 'message', role: 'assistant', model: 'synthetic-model',
    content: [{ type: 'text', text: JSON.stringify(output) }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as BetaMessage;
}

describe('M2 cassette transport', () => {
  it('fingerprint ignores presigned query but includes derived key and page order', () => {
    const first = buildS1Request([
      { pageNo: 2, imageUrl: 'https://s3.test/medical-record/derived/p23456/d23456/ai-02.webp?sig=one' },
      { pageNo: 1, imageUrl: 'https://s3.test/medical-record/derived/p23456/d23456/ai-01.webp?sig=one' },
    ], 16_000);
    const second = buildS1Request([
      { pageNo: 1, imageUrl: 'https://other.test/derived/p23456/d23456/ai-01.webp?sig=two' },
      { pageNo: 2, imageUrl: 'https://other.test/derived/p23456/d23456/ai-02.webp?sig=two' },
    ], 16_000);
    const a = cassetteFingerprint(first);
    const b = cassetteFingerprint(second);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.media).toEqual([
      'derived/p23456/d23456/ai-01.webp', 'derived/p23456/d23456/ai-02.webp',
    ]);
    expect(a.page_order).toEqual([1, 2]);
  });

  it('records a sanitized response and replays without calling upstream', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'amr-cassette-'));
    temporary.push(directory);
    const request = buildS1Request([
      { pageNo: 1, imageUrl: 'https://s3.test/derived/p23456/d23456/ai-01.webp?sig=one' },
    ], 16_000);
    const upstream = vi.fn(async () => reply());
    const recorded = await cassetteTransport(directory, upstream, true)(request);
    expect(upstream).toHaveBeenCalledTimes(1);

    const file = path.join(directory, `${cassetteFingerprint(request).fingerprint}.json`);
    const serialized = readFileSync(file, 'utf8');
    expect(JSON.parse(serialized)).toMatchObject({ provenance: 'recorded' });
    expect(() => assertNoCassettePii(serialized)).not.toThrow();
    expect(serialized).not.toContain('张三');
    expect(serialized).not.toContain('北京医院');
    const output = JSON.parse((recorded.content[0] as { text: string }).text) as Stage1OutT;
    expect(output.patient_name).toBe('P1');
    expect(output.facility_name_raw).toBe('F1');
    expect(output.pages[0]!.full_text).toContain('***********');
    expect(output.pages[0]!.full_text).toHaveLength('张三 手机13800138000 北京医院'.length);

    const replayUpstream = vi.fn(async () => { throw new Error('不得访问网络'); });
    const replayed = await cassetteTransport(directory, replayUpstream, false)(request);
    expect(replayUpstream).not.toHaveBeenCalled();
    expect(replayed).toEqual(recorded);
  });

  it('fails closed when replay cassette is missing', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'amr-cassette-'));
    temporary.push(directory);
    const request = buildS1Request([
      { pageNo: 1, imageUrl: 'https://s3.test/derived/p23456/d23456/ai-01.webp' },
    ], 16_000);
    await expect(cassetteTransport(directory, async () => reply(), false)(request))
      .rejects.toThrow('禁止访问真实网络');
  });

  it('keeps a committed, PII-scanned behavior baseline replayable', async () => {
    const directory = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/m2/cassettes',
    );
    const baseline = readdirSync(directory).find((file) => file.endsWith('.json'));
    expect(baseline).toBeDefined();
    const cassetteFile = readFileSync(path.join(directory, baseline!), 'utf8');
    const fixture = JSON.parse(cassetteFile) as { provenance: string; request: { model: string } };
    expect(fixture.provenance).toBe('synthetic');
    const fixtureModel = fixture.request.model;
    const request = {
      ...buildS1Request([
        { pageNo: 1, imageUrl: 'https://cassette.invalid/derived/p23456/d23456/ai-01.webp' },
      ], 16_000),
      model: fixtureModel,
    };
    const replayed = await cassetteTransport(directory, async () => {
      throw new Error('不得访问真实网络');
    }, false)(request);
    const output = JSON.parse((replayed.content[0] as { text: string }).text) as Stage1OutT;
    expect(output).toMatchObject({ doc_type: 'lab_report', patient_name: 'P1', facility_name_raw: 'F1' });
  });
});
