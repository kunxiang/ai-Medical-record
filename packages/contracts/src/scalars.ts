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
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
