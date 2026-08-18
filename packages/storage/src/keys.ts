// spec m0-03 §2:key 语法 BNF 的 build/parse。往返性质:parseKey(buildKey(x)) == x。
// 解析器禁止从 key 推断语法之外的语义。

const A = '[23456789a-hj-km-np-tv-z]';
const PSLUG = `p${A}{5}`;
const DSLUG = `d${A}{5}`;
const DATE = '\\d{4}-\\d{2}-\\d{2}';
const EXT = '(?:jpg|png|webp|pdf)';
const QKEY = '[a-z0-9_]{1,32}';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const KEY_BYTES_RE = /^[a-z0-9._/-]+$/;

export type ParsedKey =
  | { kind: 'page'; personSlug: string; year: string; captureDate: string; docShortId: string; pageNo: number; ext: string }
  | { kind: 'pageMeta'; personSlug: string; year: string; captureDate: string; docShortId: string; pageNo: number }
  | { kind: 'capture'; personSlug: string; year: string; captureDate: string; docShortId: string }
  | { kind: 'correction'; personSlug: string; year: string; captureDate: string; docShortId: string; seq: number }
  | { kind: 'audio'; personSlug: string; year: string; captureDate: string; docShortId: string; qkey: string; ext: 'm4a' | 'json' }
  | { kind: 'person'; personSlug: string }
  | { kind: 'journal'; personSlug: string; year: string; month: string }
  | { kind: 'manifest'; year: string; month: string }
  | { kind: 'peopleMap' }
  | { kind: 'incoming'; batchId: string; uploadId: string }
  | { kind: 'probe'; name: 'startup' | 'lock-probe' };

function docdirPrefix(personSlug: string, captureDate: string, docShortId: string): string {
  const year = captureDate.slice(0, 4);
  return `people/${personSlug}/${year}/${captureDate}__${docShortId}`;
}

function pad2(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error(`页号越界: ${n}`);
  return String(n).padStart(2, '0');
}

export const buildKey = {
  page: (p: { personSlug: string; captureDate: string; docShortId: string; pageNo: number; ext: string }) =>
    check(`${docdirPrefix(p.personSlug, p.captureDate, p.docShortId)}/page-${pad2(p.pageNo)}.${p.ext}`),
  pageMeta: (p: { personSlug: string; captureDate: string; docShortId: string; pageNo: number }) =>
    check(`${docdirPrefix(p.personSlug, p.captureDate, p.docShortId)}/page-${pad2(p.pageNo)}.json`),
  capture: (p: { personSlug: string; captureDate: string; docShortId: string }) =>
    check(`${docdirPrefix(p.personSlug, p.captureDate, p.docShortId)}/capture.json`),
  correction: (p: { personSlug: string; captureDate: string; docShortId: string; seq: number }) => {
    if (!Number.isInteger(p.seq) || p.seq < 1 || p.seq > 9999) throw new Error(`seq 越界: ${p.seq}`);
    return check(
      `${docdirPrefix(p.personSlug, p.captureDate, p.docShortId)}/correction-${String(p.seq).padStart(4, '0')}.json`,
    );
  },
  audio: (p: { personSlug: string; captureDate: string; docShortId: string; qkey: string; ext: 'm4a' | 'json' }) =>
    check(`${docdirPrefix(p.personSlug, p.captureDate, p.docShortId)}/audio/${p.qkey}.${p.ext}`),
  person: (p: { personSlug: string }) => check(`people/${p.personSlug}/_person.json`),
  journal: (p: { personSlug: string; year: string; month: string }) =>
    check(`people/${p.personSlug}/journal/${p.year}-${p.month}.jsonl`),
  manifest: (p: { year: string; month: string }) => check(`_index/manifests/${p.year}-${p.month}.jsonl`),
  peopleMap: () => `_index/people.json`,
  incoming: (p: { batchId: string; uploadId: string }) => check(`_incoming/${p.batchId}/${p.uploadId}`),
  probe: (name: 'startup' | 'lock-probe', suffix?: string) =>
    check(`_probe/${name}${suffix ? '-' + suffix : ''}`),
  // derived 构造器:M0 仅预留(spec m0-03 §5.5)
  derivedMeta: (p: { personSlug: string; docShortId: string }) =>
    check(`derived/${p.personSlug}/${p.docShortId}/meta.json`),
};

function check(key: string): string {
  if (!KEY_BYTES_RE.test(key)) throw new Error(`key 含非法字符: ${key}`);
  return key;
}

const MATCHERS: Array<[RegExp, (m: RegExpExecArray) => ParsedKey]> = [
  [
    new RegExp(`^people/(${PSLUG})/(\\d{4})/(${DATE})__(${DSLUG})/page-(\\d{2})\\.(${EXT})$`),
    (m) => ({ kind: 'page', personSlug: m[1]!, year: m[2]!, captureDate: m[3]!, docShortId: m[4]!, pageNo: parseInt(m[5]!, 10), ext: m[6]! }),
  ],
  [
    new RegExp(`^people/(${PSLUG})/(\\d{4})/(${DATE})__(${DSLUG})/page-(\\d{2})\\.json$`),
    (m) => ({ kind: 'pageMeta', personSlug: m[1]!, year: m[2]!, captureDate: m[3]!, docShortId: m[4]!, pageNo: parseInt(m[5]!, 10) }),
  ],
  [
    new RegExp(`^people/(${PSLUG})/(\\d{4})/(${DATE})__(${DSLUG})/capture\\.json$`),
    (m) => ({ kind: 'capture', personSlug: m[1]!, year: m[2]!, captureDate: m[3]!, docShortId: m[4]! }),
  ],
  [
    new RegExp(`^people/(${PSLUG})/(\\d{4})/(${DATE})__(${DSLUG})/correction-(\\d{4})\\.json$`),
    (m) => ({ kind: 'correction', personSlug: m[1]!, year: m[2]!, captureDate: m[3]!, docShortId: m[4]!, seq: parseInt(m[5]!, 10) }),
  ],
  [
    new RegExp(`^people/(${PSLUG})/(\\d{4})/(${DATE})__(${DSLUG})/audio/(${QKEY})\\.(m4a|json)$`),
    (m) => ({ kind: 'audio', personSlug: m[1]!, year: m[2]!, captureDate: m[3]!, docShortId: m[4]!, qkey: m[5]!, ext: m[6]! as 'm4a' | 'json' }),
  ],
  [new RegExp(`^people/(${PSLUG})/_person\\.json$`), (m) => ({ kind: 'person', personSlug: m[1]! })],
  [
    new RegExp(`^people/(${PSLUG})/journal/(\\d{4})-(\\d{2})\\.jsonl$`),
    (m) => ({ kind: 'journal', personSlug: m[1]!, year: m[2]!, month: m[3]! }),
  ],
  [
    new RegExp(`^_index/manifests/(\\d{4})-(\\d{2})\\.jsonl$`),
    (m) => ({ kind: 'manifest', year: m[1]!, month: m[2]! }),
  ],
  [new RegExp(`^_index/people\\.json$`), () => ({ kind: 'peopleMap' })],
  [
    new RegExp(`^_incoming/(${UUID})/(${UUID})$`),
    (m) => ({ kind: 'incoming', batchId: m[1]!, uploadId: m[2]! }),
  ],
  [
    new RegExp(`^_probe/(startup|lock-probe)(?:-[a-z0-9]{1,16})?$`),
    (m) => ({ kind: 'probe', name: m[1]! as 'startup' | 'lock-probe' }),
  ],
];

export function parseKey(key: string): ParsedKey {
  if (!KEY_BYTES_RE.test(key)) throw new Error(`key 含非法字符: ${key}`);
  for (const [re, f] of MATCHERS) {
    const m = re.exec(key);
    if (m) {
      const parsed = f(m);
      // 语法内一致性:目录年份段 == capture_date 年份
      if ('captureDate' in parsed && 'year' in parsed && parsed.captureDate.slice(0, 4) !== parsed.year) {
        throw new Error(`目录年份与 capture_date 不一致: ${key}`);
      }
      return parsed;
    }
  }
  throw new Error(`无法解析的 key: ${key}`);
}
