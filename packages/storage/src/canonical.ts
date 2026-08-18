// canonical 序列化的唯一实现在 @amr/contracts(它同时被 PWA 使用);此处只做 Buffer 封装。
import { canonicalJsonString } from '@amr/contracts';

/** 单个 JSON 文档 → canonical 字节(结尾 \n) */
export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(canonicalJsonString(value), 'utf-8');
}

/** JSONL 行 → canonical 字节(单行 + \n) */
export function canonicalJsonl(value: unknown): Buffer {
  return canonicalJson(value);
}
