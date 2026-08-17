import { z } from 'zod';

// spec m0-01 §6(M0 全集)
export const ERROR_CODES = {
  validation_failed: 400,
  person_confirmation_required: 400,
  unauthenticated: 401,
  not_found: 404,
  duplicate_client_document_id: 409,
  sha256_mismatch: 409,
  upload_consumed: 409,
  file_too_large: 413,
  unsupported_media_type: 422,
  upload_incomplete: 422,
  rate_limited: 429,
  internal_error: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});
