// canonical 序列化(m0-03 §4):schema_version 置首,其余键递归字典序。
// storage 依赖 contracts,故实现放这里,storage 复用之(单一实现,禁止两份)。
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function sortValue(v: Json, topLevel: boolean): Json {
  if (Array.isArray(v)) return v.map((x) => sortValue(x, false));
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    if (topLevel) {
      const i = keys.indexOf('schema_version');
      if (i > 0) { keys.splice(i, 1); keys.unshift('schema_version'); }
    }
    const out: { [k: string]: Json } = {};
    for (const k of keys) out[k] = sortValue((v as { [k: string]: Json })[k]!, false);
    return out;
  }
  return v;
}

export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(sortValue(value as Json, true)) + '\n';
}
