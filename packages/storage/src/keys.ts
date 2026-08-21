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

/** 派生物变体(ADR-050 新增 ai:送进模型的输入,旋正 + 长边 2576 + q92) */
export type DerivativeVariant = 'thumb' | 'preview' | 'ai';

export type ParsedKey =
  | { kind: 'page'; personSlug: string; year: string; captureDate: string; docShortId: string; pageNo: number; ext: string }
  | { kind: 'pageMeta'; personSlug: string; year: string; captureDate: string; docShortId: string; pageNo: number }
  | { kind: 'capture'; personSlug: string; year: string; captureDate: string; docShortId: string }
  | { kind: 'correction'; personSlug: string; year: string; captureDate: string; docShortId: string; seq: number }
  | { kind: 'audio'; personSlug: string; year: string; captureDate: string; docShortId: string; qkey: string; ext: 'm4a' | 'json' }
  | { kind: 'person'; personSlug: string }
  | { kind: 'journal'; personSlug: string; year: string; month: string }
  | { kind: 'manifest'; year: string; month: string }
  | { kind: 'audit'; year: string; month: string }
  | { kind: 'peopleMap' }
  | { kind: 'incoming'; batchId: string; uploadId: string }
  | { kind: 'probe'; name: 'startup' | 'lock-probe' }
  | { kind: 'derivedMeta'; personSlug: string; docShortId: string }
  | { kind: 'derivative'; personSlug: string; docShortId: string; variant: DerivativeVariant; pageNo: number }
  | { kind: 'extraction'; personSlug: string; docShortId: string; stage: string; promptVersion: number }
  | { kind: 'meta'; path: string };

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
  audit: (p: { year: string; month: string }) => check(`_index/audit/${p.year}-${p.month}.jsonl`),
  peopleMap: () => `_index/people.json`,
  incoming: (p: { batchId: string; uploadId: string }) => check(`_incoming/${p.batchId}/${p.uploadId}`),
  probe: (name: 'startup' | 'lock-probe', suffix?: string) =>
    check(`_probe/${name}${suffix ? '-' + suffix : ''}`),
  // derived 构造器(M1:派生物落地;m1-03 §1)
  derivedMeta: (p: { personSlug: string; docShortId: string }) =>
    check(`derived/${p.personSlug}/${p.docShortId}/meta.json`),
  derivative: (p: { personSlug: string; docShortId: string; variant: DerivativeVariant; pageNo: number }) =>
    check(`derived/${p.personSlug}/${p.docShortId}/${p.variant}-${pad2(p.pageNo)}.webp`),
  derivedPrefix: (p: { personSlug: string; docShortId: string }) =>
    check(`derived/${p.personSlug}/${p.docShortId}/`),
  /** S1/S2 提取工件(m2-03 §4)。
   *  `{slug}` **恒取权威归属 slug**(manifests 回放的结果),不是拍摄时刻的 slug ——
   *  否则重建时按权威 slug 查找会对所有被纠正过的文档静默落空(审核 #004 B-6)。
   *  命名不含 `@`:那不在 M0 冻结的 key 字节集内(审核 #004 A-3)。 */
  extraction: (p: { personSlug: string; docShortId: string; stage: string; promptVersion: number }) => {
    if (!/^[a-z0-9]{1,8}$/.test(p.stage)) throw new Error(`非法 stage: ${p.stage}`);
    if (!Number.isInteger(p.promptVersion) || p.promptVersion < 1 || p.promptVersion > 999) {
      throw new Error(`promptVersion 越界: ${p.promptVersion}`);
    }
    return check(
      `derived/${p.personSlug}/${p.docShortId}/extractions/` +
      `${p.stage}-v${String(p.promptVersion).padStart(3, '0')}.json`,
    );
  },
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
  [
    new RegExp(`^_index/audit/(\\d{4})-(\\d{2})\\.jsonl$`),
    (m) => ({ kind: 'audit', year: m[1]!, month: m[2]! }),
  ],
  [new RegExp(`^_index/people\\.json$`), () => ({ kind: 'peopleMap' })],
  [
    new RegExp(`^_incoming/(${UUID})/(${UUID})$`),
    (m) => ({ kind: 'incoming', batchId: m[1]!, uploadId: m[2]! }),
  ],
  [
    new RegExp(`^derived/(${PSLUG})/(${DSLUG})/meta\\.json$`),
    (m) => ({ kind: 'derivedMeta', personSlug: m[1]!, docShortId: m[2]! }),
  ],
  [
    // 提取工件(m2-03 §4)。stage 与三位版本号,不含 `@`。
    new RegExp(`^derived/(${PSLUG})/(${DSLUG})/extractions/([a-z0-9]{1,8})-v(\\d{3})\\.json$`),
    (m) => ({
      kind: 'extraction', personSlug: m[1]!, docShortId: m[2]!,
      stage: m[3]!, promptVersion: parseInt(m[4]!, 10),
    }),
  ],
  [
    // _meta 自述层。m0/m1 的矩阵扫描显式跳过它;M2 的 A30 把它纳入,
    // 因此必须有匹配器,否则 A30 会先在 gen-meta 写的对象上失败(审核 #004 B-5)。
    new RegExp(`^_meta/([A-Za-z0-9._/-]+)$`),
    (m) => {
      if (!isMetaPath(m[1]!)) throw new Error(`_meta key 非法: ${m[0]}`);
      return { kind: 'meta', path: m[1]! };
    },
  ],
  [
    new RegExp(`^derived/(${PSLUG})/(${DSLUG})/(thumb|preview|ai)-(\\d{2})\\.webp$`),
    (m) => ({
      kind: 'derivative', personSlug: m[1]!, docShortId: m[2]!,
      variant: m[3]! as DerivativeVariant, pageNo: parseInt(m[4]!, 10),
    }),
  ],
  [
    new RegExp(`^_probe/(startup|lock-probe)(?:-[a-z0-9]{1,16})?$`),
    (m) => ({ kind: 'probe', name: m[1]! as 'startup' | 'lock-probe' }),
  ],
];

/** `_meta/` 是**手写的自述层**,不是机器生成的数据 key。
 *  `_meta/README.md` 的大写字母不在 KEY_BYTES_RE 内 —— 而这个名字是刻意的:
 *  README 是通用约定,二十年后拿到桶的人第一眼要看的就是它,docs/04 也是这么引用的。
 *  因此字节集不变式的作用域是 **L1/L2 的数据 key**,`_meta/` 单独放行。
 *  (这条是 m2-99 A30 把 `_meta/` 纳入矩阵扫描时才暴露出来的 —— 既有对象本就在不变式之外。) */
const META_PREFIX = '_meta/';
const META_CHARS_RE = /^[A-Za-z0-9._-]+$/;

/** `_meta/` 下的合法路径:非空、逐段只含允许字符、**且没有 `..` 段**。
 *  字节集允许 `.` 与 `/`,不显式挡一下的话 `_meta/../people/x` 会被解析成合法 meta key ——
 *  一个能绕过前缀归属判断的口子。这里用分段检查而不是 lookahead 正则:
 *  正则里的 `^` 指的是整串开头,挡不住"开头就是 `..`"的情形(实际写错过一次)。 */
function isMetaPath(path: string): boolean {
  if (path.length === 0) return false;
  return path.split('/').every((seg) => seg !== '..' && META_CHARS_RE.test(seg));
}

export function parseKey(key: string): ParsedKey {
  if (key.startsWith(META_PREFIX)) {
    if (!isMetaPath(key.slice(META_PREFIX.length))) throw new Error(`_meta key 非法: ${key}`);
  } else if (!KEY_BYTES_RE.test(key)) {
    throw new Error(`key 含非法字符: ${key}`);
  }
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
