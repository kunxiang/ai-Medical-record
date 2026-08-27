import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJsonString } from '@amr/contracts';
import type { BetaMessage, BetaMessageCreateParams, Transport } from './transport.js';

export const CASSETTE_SCHEMA_VERSION = '1.0' as const;
export const PII_PATTERNS = {
  phone: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  idCard: /(?<!\d)\d{17}[\dXx](?!\d)/g,
} as const;

type Cassette = {
  schema_version: typeof CASSETTE_SCHEMA_VERSION;
  /** recorded 才能作为 wire-boundary 验收基准；synthetic 只允许做离线场景开发。 */
  provenance: 'recorded' | 'synthetic';
  fingerprint: string;
  request: {
    model: string;
    prompt_sha256: string;
    media: string[];
    page_order: number[];
    request_sha256: string;
  };
  response: BetaMessage;
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function mediaKey(url: string): string {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const derived = pathname.indexOf('/derived/');
    return derived >= 0 ? pathname.slice(derived + 1) : pathname.replace(/^\//, '');
  } catch {
    return url;
  }
}

function normalizedRequest(params: BetaMessageCreateParams): unknown {
  const clone = structuredClone(params) as unknown as Record<string, unknown>;
  const messages = clone['messages'] as Array<{ content?: unknown }>;
  for (const message of messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      const source = block['source'] as Record<string, unknown> | undefined;
      if (block['type'] === 'image' && source?.['type'] === 'url') {
        source['url'] = mediaKey(String(source['url']));
      }
      if (block['type'] === 'document' && source?.['type'] === 'base64') {
        source['data'] = `sha256:${sha256(String(source['data']))}`;
      }
    }
  }
  return clone;
}

export function cassetteFingerprint(params: BetaMessageCreateParams): Cassette['request'] & { fingerprint: string } {
  const normalized = normalizedRequest(params);
  const system = typeof params.system === 'string'
    ? params.system
    : (params.system ?? []).map((block) => block.type === 'text' ? block.text : '').join('\n\n');
  const media: string[] = [];
  const pageOrder: number[] = [];
  for (const message of params.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as unknown as Array<Record<string, unknown>>) {
      const text = typeof block['text'] === 'string' ? block['text'] : null;
      if (text) {
        for (const page of text.matchAll(/第\s*(\d+)\s*页/g)) pageOrder.push(Number(page[1]));
      }
      const source = block['source'] as Record<string, unknown> | undefined;
      if (block['type'] === 'image' && source?.['type'] === 'url') media.push(mediaKey(String(source['url'])));
      if (block['type'] === 'document' && source?.['type'] === 'base64') {
        media.push(`document:${String(source['media_type'])}:sha256:${sha256(String(source['data']))}`);
      }
    }
  }
  const request = {
    model: params.model,
    prompt_sha256: sha256(system),
    media,
    page_order: pageOrder,
    request_sha256: sha256(canonicalJsonString(normalized)),
  };
  return { ...request, fingerprint: sha256(canonicalJsonString(request)) };
}

function sameLengthPlaceholder(value: string, token: string): string {
  return (token + '*'.repeat(value.length)).slice(0, value.length);
}

function replaceEvery(value: unknown, needle: string, token: string): unknown {
  if (!needle) return value;
  if (typeof value === 'string') return value.split(needle).join(sameLengthPlaceholder(needle, token));
  if (Array.isArray(value)) return value.map((item) => replaceEvery(item, needle, token));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceEvery(item, needle, token)]));
  }
  return value;
}

function maskRegexPii(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(PII_PATTERNS.phone, (match) => '*'.repeat(match.length))
      .replace(PII_PATTERNS.idCard, (match) => '*'.repeat(match.length));
  }
  if (Array.isArray(value)) return value.map(maskRegexPii);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskRegexPii(item)]));
  }
  return value;
}

function sanitizeOutput(text: string): string {
  let output: Record<string, unknown>;
  try {
    output = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return String(maskRegexPii(text));
  }

  const pages = Array.isArray(output['pages']) ? output['pages'] as Array<Record<string, unknown>> : [];
  const spans = Array.isArray(output['pii_spans'])
    ? output['pii_spans'] as Array<{ page_no?: number; start?: number; end?: number }>
    : [];
  for (const page of pages) {
    let fullText = String(page['full_text'] ?? '');
    const pageNo = Number(page['page_no']);
    const pageSpans = spans
      .filter((span) => span.page_no === pageNo && Number.isInteger(span.start) && Number.isInteger(span.end))
      .sort((a, b) => Number(b.start) - Number(a.start));
    for (const span of pageSpans) {
      const start = Math.max(0, Number(span.start));
      const end = Math.min(fullText.length, Number(span.end));
      if (end > start) fullText = fullText.slice(0, start) + '*'.repeat(end - start) + fullText.slice(end);
    }
    page['full_text'] = fullText;
  }

  const patientName = typeof output['patient_name'] === 'string' ? output['patient_name'] : '';
  const facilityName = typeof output['facility_name_raw'] === 'string' ? output['facility_name_raw'] : '';
  output = replaceEvery(output, patientName, 'P1') as Record<string, unknown>;
  output = replaceEvery(output, facilityName, 'F1') as Record<string, unknown>;
  if (patientName) output['patient_name'] = 'P1';
  if (facilityName) output['facility_name_raw'] = 'F1';

  // facility normalization 响应没有 Stage1Out 的 pii_spans；名称仍必须占位化。
  if ('action' in output && typeof output['name'] === 'string') {
    const name = output['name'];
    output = replaceEvery(output, name, 'F1') as Record<string, unknown>;
    output['name'] = 'F1';
  }
  return JSON.stringify(maskRegexPii(output));
}

export function sanitizeCassetteResponse(response: BetaMessage): BetaMessage {
  const clone = structuredClone(response) as BetaMessage;
  const content = clone.content as unknown as Array<Record<string, unknown>>;
  for (const block of content) {
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      block['text'] = sanitizeOutput(block['text']);
    }
  }
  return clone;
}

export function assertNoCassettePii(value: string, label = 'cassette'): void {
  for (const [kind, pattern] of Object.entries(PII_PATTERNS)) {
    pattern.lastIndex = 0;
    const hit = pattern.exec(value);
    if (hit) throw new Error(`${label} 含未遮蔽 ${kind}: offset=${hit.index}`);
  }
}

export function cassetteTransport(
  directory: string,
  upstream: Transport,
  record: boolean,
): Transport {
  return async (params) => {
    const request = cassetteFingerprint(params);
    const file = path.join(directory, `${request.fingerprint}.json`);
    if (existsSync(file)) {
      if (record) throw new Error(`cassette 已存在，拒绝静默覆盖: ${file}`);
      const cassette = JSON.parse(readFileSync(file, 'utf8')) as Cassette;
      if (cassette.schema_version !== CASSETTE_SCHEMA_VERSION || cassette.fingerprint !== request.fingerprint) {
        throw new Error(`cassette 元数据不匹配: ${file}`);
      }
      if (cassette.provenance !== 'recorded' && cassette.provenance !== 'synthetic') {
        throw new Error(`cassette 缺少合法 provenance: ${file}`);
      }
      return cassette.response;
    }
    if (!record) throw new Error(`cassette 不存在，禁止访问真实网络: ${file}`);

    const response = sanitizeCassetteResponse(await upstream(params));
    const cassette: Cassette = {
      schema_version: CASSETTE_SCHEMA_VERSION,
      provenance: 'recorded',
      fingerprint: request.fingerprint,
      request: {
        model: request.model, prompt_sha256: request.prompt_sha256,
        media: request.media, page_order: request.page_order,
        request_sha256: request.request_sha256,
      },
      response,
    };
    const serialized = JSON.stringify(cassette, null, 2) + '\n';
    assertNoCassettePii(serialized, file);
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, serialized, { flag: 'wx' });
    return response;
  };
}

export function cassetteTransportFromEnv(upstream: Transport): Transport {
  const directory = process.env.AMR_AI_CASSETTE_DIR?.trim();
  if (!directory) return upstream;
  return cassetteTransport(path.resolve(directory), upstream, process.env.AMR_AI_RECORD === '1');
}
