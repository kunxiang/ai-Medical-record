export type Comparator = '<' | '<=' | '=' | '>=' | '>';

export type ParsedResult =
  | { kind: 'numeric'; raw: string; comparator: Comparator; value: number; text: null }
  | { kind: 'text'; raw: string; comparator: null; value: null; text: string };

/** 只解析显式数值和比较符；无法确定时原样作为文字结果，不猜。 */
export function parseResultValue(input: string): ParsedResult {
  const raw = input.trim();
  const normalized = raw.replace(/^≤/, '<=').replace(/^≥/, '>=').replace(/^＜/, '<').replace(/^＞/, '>');
  const match = normalized.match(/^(<=|>=|<|>|=)?\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
  if (!match) return { kind: 'text', raw, comparator: null, value: null, text: raw };
  const value = Number(match[2]);
  if (!Number.isFinite(value)) return { kind: 'text', raw, comparator: null, value: null, text: raw };
  return {
    kind: 'numeric', raw,
    comparator: (match[1] ?? '=') as Comparator,
    value, text: null,
  };
}
