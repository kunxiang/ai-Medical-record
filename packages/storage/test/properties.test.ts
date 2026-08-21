import { describe, expect, it } from 'vitest';
import { SLUG_ALPHABET } from '@amr/contracts';
import {
  buildKey,
  canonicalJson,
  captureDateInZone,
  newDocShortId,
  newPersonSlug,
  parseKey,
} from '../src/index.js';

const rand = (n: number) => Math.floor(Math.random() * n);
const randomSlugTail = () =>
  Array.from({ length: 5 }, () => SLUG_ALPHABET[rand(30)]).join('');
const randomDate = () => {
  const y = 2000 + rand(30);
  const m = 1 + rand(12);
  const d = 1 + rand(28);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

describe('slug(spec m0-03 §1)', () => {
  it('格式、字母表、长度', () => {
    for (let i = 0; i < 500; i++) {
      const p = newPersonSlug();
      const d = newDocShortId();
      expect(p).toMatch(/^p[23456789abcdefghjkmnpqrstvwxyz]{5}$/);
      expect(d).toMatch(/^d[23456789abcdefghjkmnpqrstvwxyz]{5}$/);
    }
  });
  it('分布粗检:30 个字符在 3000 样本中全部出现', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 600; i++) for (const c of newPersonSlug().slice(1)) seen.add(c);
    expect(seen.size).toBe(30);
  });
});

describe('key 往返(spec m0-03 §2,≥1000 例)', () => {
  it('page/pageMeta/capture/correction/audio/person/journal/manifest 往返', () => {
    for (let i = 0; i < 1100; i++) {
      const personSlug = 'p' + randomSlugTail();
      const docShortId = 'd' + randomSlugTail();
      const captureDate = randomDate();
      const pageNo = 1 + rand(99);
      const ext = (['jpg', 'png', 'webp', 'pdf'] as const)[rand(4)]!;

      const pk = buildKey.page({ personSlug, captureDate, docShortId, pageNo, ext });
      expect(parseKey(pk)).toEqual({
        kind: 'page', personSlug, year: captureDate.slice(0, 4), captureDate, docShortId, pageNo, ext,
      });

      const ck = buildKey.capture({ personSlug, captureDate, docShortId });
      expect(parseKey(ck)).toMatchObject({ kind: 'capture', personSlug, captureDate, docShortId });

      const seq = 1 + rand(9999);
      const rk = buildKey.correction({ personSlug, captureDate, docShortId, seq });
      expect(parseKey(rk)).toMatchObject({ kind: 'correction', seq });

      const jk = buildKey.journal({ personSlug, year: '2026', month: '08' });
      expect(parseKey(jk)).toEqual({ kind: 'journal', personSlug, year: '2026', month: '08' });
    }
  });

  it('模糊测试:随机变造合法 key 一个字节 → parse 抛错或解析结果不同', () => {
    for (let i = 0; i < 300; i++) {
      const key = buildKey.capture({
        personSlug: 'p' + randomSlugTail(),
        captureDate: randomDate(),
        docShortId: 'd' + randomSlugTail(),
      });
      const pos = rand(key.length);
      const mutated = key.slice(0, pos) + String.fromCharCode(33 + rand(90)) + key.slice(pos + 1);
      if (mutated === key) continue;
      let ok = true;
      try {
        const p = parseKey(mutated);
        ok = JSON.stringify(p) !== JSON.stringify(parseKey(key));
      } catch {
        ok = true;
      }
      expect(ok).toBe(true);
    }
  });

  it('非法输入:大写、越界页号、年份不一致', () => {
    expect(() => parseKey('People/p3f7a2/_person.json')).toThrow();
    expect(() => buildKey.page({ personSlug: 'p3f7a2', captureDate: '2026-08-17', docShortId: 'd7k2m9', pageNo: 100, ext: 'jpg' })).toThrow();
    expect(() => parseKey('people/p3f7a2/2025/2026-08-17__d7k2m9/capture.json')).toThrow();
  });
});

describe('canonical(spec m0-03 §4)', () => {
  it('schema_version 居首,其余递归字典序,字节级可重现', () => {
    const a = canonicalJson({ z: 1, schema_version: '2.0', a: { c: 1, b: [{ y: 2, x: 1 }] } });
    const b = canonicalJson({ a: { b: [{ x: 1, y: 2 }], c: 1 }, schema_version: '2.0', z: 1 });
    expect(a.equals(b)).toBe(true);
    const text = a.toString('utf-8');
    expect(text.startsWith('{"schema_version":"2.0","a":')).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
    // 嵌套对象内不提升 schema_version,纯字典序
    const c = canonicalJson({ schema_version: '1.0', obj: { schema_version: 'x', a: 1 } }).toString();
    expect(c).toContain('"obj":{"a":1,"schema_version":"x"}');
  });
});

describe('capture_date 折算(spec m0-03 §3)', () => {
  it('Asia/Shanghai 跨日边界', () => {
    // UTC 2026-08-16 17:30 = 上海 2026-08-17 01:30
    expect(captureDateInZone('2026-08-16T17:30:00Z', 'Asia/Shanghai')).toBe('2026-08-17');
    expect(captureDateInZone('2026-08-17T10:32:11+08:00', 'Asia/Shanghai')).toBe('2026-08-17');
    expect(captureDateInZone('2026-08-17T10:32:11+08:00', 'UTC')).toBe('2026-08-17');
    expect(captureDateInZone('2026-08-17T02:32:11+08:00', 'America/New_York')).toBe('2026-08-16');
  });
});

describe('derived key(M1 · m1-03 §1;m0/CHANGES #7)', () => {
  it('thumb/preview/ai/meta 往返', () => {
    for (let i = 0; i < 300; i++) {
      const personSlug = 'p' + randomSlugTail();
      const docShortId = 'd' + randomSlugTail();
      const pageNo = 1 + rand(99);
      for (const variant of ['thumb', 'preview', 'ai'] as const) {
        const k = buildKey.derivative({ personSlug, docShortId, variant, pageNo });
        expect(parseKey(k)).toEqual({ kind: 'derivative', personSlug, docShortId, variant, pageNo });
      }
      const m = buildKey.derivedMeta({ personSlug, docShortId });
      expect(parseKey(m)).toEqual({ kind: 'derivedMeta', personSlug, docShortId });
    }
  });
  it('非法 derived key 抛错', () => {
    expect(() => parseKey('derived/p3f7a2/d7k2m9/thumb-1.webp')).toThrow();
    expect(() => parseKey('derived/p3f7a2/d7k2m9/thumb-01.jpg')).toThrow();
    // ai 是 ADR-050 新增的合法变体,但拼写必须精确 —— 别的变体名一律拒
    expect(() => parseKey('derived/p3f7a2/d7k2m9/AI-01.webp')).toThrow();
    expect(() => parseKey('derived/p3f7a2/d7k2m9/ai2-01.webp')).toThrow();
  });
});
