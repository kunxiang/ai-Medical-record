// spec m1-99 B11:幂等指纹的稳定语义子集。
// 这条测试的存在理由:旧口径把整包 payload 当幂等键,而重试必然重新 presign,
// batch_id/upload_id 必变 ⇒ 每次重试都 409 终止(审核 #002 A-1)。
import { describe, expect, it } from 'vitest';
import { DocumentCreate, idempotencyFingerprint } from '../src/document.js';

const PERSON = '018f0000-0000-7000-8000-00000000aaaa';
const base = {
  person_id: PERSON,
  person_confirmed: true as const,
  confirmed_by: 'capture_ui' as const,
  batch_id: '018f0000-0000-7000-8000-00000000bbbb',
  source: 'camera' as const,
  captured_at: '2024-03-15T08:30:00.000Z',
  client_document_id: '018f0000-0000-7000-8000-00000000cccc',
  pages: [
    {
      upload_id: '018f0000-0000-7000-8000-00000000dddd',
      page_no: 1, capture_order: 1, width: 1200, height: 800,
      sha256: 'a'.repeat(64), exif: null,
    },
    {
      upload_id: '018f0000-0000-7000-8000-00000000eeee',
      page_no: 2, capture_order: 2, width: 1200, height: 800,
      sha256: 'b'.repeat(64), exif: null,
    },
  ],
};
const fp = (o: unknown) => idempotencyFingerprint(DocumentCreate.parse(o));

describe('idempotencyFingerprint', () => {
  it('传输载体变化不改变指纹(重试必然重新 presign)', () => {
    const retried = {
      ...base,
      batch_id: '018f0000-0000-7000-8000-000000009999',
      pages: base.pages.map((p, i) => ({ ...p, upload_id: `018f0000-0000-7000-8000-00000000ff${i}0` })),
    };
    expect(fp(retried)).toBe(fp(base));
  });

  it('exif 变化不改变指纹(客户端解析,允许版本差异)', () => {
    const withExif = {
      ...base,
      pages: base.pages.map((p) => ({ ...p, exif: { captured_at: null, orientation: 6 } })),
    };
    expect(fp(withExif)).toBe(fp(base));
  });

  it('页序颠倒不改变指纹(登记顺序不是语义)', () => {
    expect(fp({ ...base, pages: [base.pages[1]!, base.pages[0]!] })).toBe(fp(base));
  });

  it.each([
    ['sha256', { pages: [{ ...base.pages[0]!, sha256: 'c'.repeat(64) }, base.pages[1]!] }],
    ['capture_order', { pages: [{ ...base.pages[0]!, capture_order: 2 }, { ...base.pages[1]!, capture_order: 1 }] }],
    ['width', { pages: [{ ...base.pages[0]!, width: 1201 }, base.pages[1]!] }],
    ['captured_at', { captured_at: '2024-03-15T08:30:01.000Z' }],
    ['source', { source: 'album' as const }],
    ['confirmed_by', { confirmed_by: 'api' as const }],
    ['person_id', { person_id: '018f0000-0000-7000-8000-000000001111' }],
    ['client_document_id', { client_document_id: '018f0000-0000-7000-8000-000000002222' }],
  ])('语义字段 %s 变化必须改变指纹', (_name, patch) => {
    expect(fp({ ...base, ...patch })).not.toBe(fp(base));
  });

  it('页数变化必须改变指纹', () => {
    expect(fp({ ...base, pages: [base.pages[0]!] })).not.toBe(fp(base));
  });

  it('指纹字节级可重现', () => {
    expect(fp(base)).toBe(fp(structuredClone(base)));
  });
});
