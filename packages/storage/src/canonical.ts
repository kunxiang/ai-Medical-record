// spec m0-03 §4(审核 #001 #8 钉死):
// schema_version 置首,其余键(含嵌套对象,递归)按字典序;UTF-8 无 BOM;文件以 \n 结尾。
// 同一输入必须字节级可重现。

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function sortValue(v: Json, topLevel: boolean): Json {
  if (Array.isArray(v)) return v.map((x) => sortValue(x, false));
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    if (topLevel) {
      const i = keys.indexOf('schema_version');
      if (i > 0) {
        keys.splice(i, 1);
        keys.unshift('schema_version');
      }
    }
    const out: { [k: string]: Json } = {};
    for (const k of keys) out[k] = sortValue((v as { [k: string]: Json })[k]!, false);
    return out;
  }
  return v;
}

/** 单个 JSON 文档 → canonical 字节(结尾 \n) */
export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(sortValue(value as Json, true)) + '\n', 'utf-8');
}

/** JSONL 行 → canonical 字节(单行 + \n),用于 journal/manifest 追加 */
export function canonicalJsonl(value: unknown): Buffer {
  return canonicalJson(value);
}
