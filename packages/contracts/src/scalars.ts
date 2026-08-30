import { z } from 'zod';

// spec m0-01 §1
export const Uuid = z
  .string()
  .uuid()
  .transform((s) => s.toLowerCase());

export const SLUG_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
export const PERSON_SLUG_RE = /^p[23456789abcdefghjkmnpqrstvwxyz]{5}$/;
export const DOC_SHORT_ID_RE = /^d[23456789abcdefghjkmnpqrstvwxyz]{5}$/;
export const PersonSlug = z.string().regex(PERSON_SLUG_RE);
export const DocShortId = z.string().regex(DOC_SHORT_ID_RE);

// 真实日历日校验(2026-13-45 必须失败)
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const t = Date.parse(s + 'T00:00:00Z');
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  }, '不是真实日历日');

export const IsoDateTime = z.string().datetime({ offset: true });

/** 单据上印的时刻常常不带时区(如 "2026-08-21T19:08:00")。视觉模型如实转录它是对的,
 *  凭空补一个偏移才是编造(设计债 D22 同源)。此标量接受两种形态,由调用方按已知时区解释;
 *  写库前必须归一为带偏移的瞬时,禁止交给 `new Date()` 按进程本地时区默认解释。 */
export const LocalOrOffsetDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
    '不是 ISO 日期时间',
  )
  .refine((v) => !Number.isNaN(Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(v) ? v : `${v}Z`)), '不是真实时刻');
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
