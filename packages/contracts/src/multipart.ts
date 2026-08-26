import { z } from 'zod';
import { Sha256Hex, Uuid } from './scalars.js';

export const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

export const MultipartCreateRequest = z.object({ upload_file_id: Uuid }).strict();
export const MultipartCreateResponse = z.object({
  upload_id: z.string().min(1),
  key: z.string().min(1),
  part_size: z.literal(MULTIPART_PART_BYTES),
  part_count: z.number().int().min(2).max(10_000),
}).strict();

export const MultipartSignRequest = z.object({
  upload_id: z.string().min(1),
  part_numbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.part_numbers).size !== value.part_numbers.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['part_numbers'], message: '分片号不能重复' });
  }
});
export const MultipartSignResponse = z.object({
  parts: z.array(z.object({ part_number: z.number().int().min(1), url: z.string().url() }).strict()),
  expires_at: z.string().datetime({ offset: true }),
}).strict();

export const MultipartCompletedPart = z.object({
  part_number: z.number().int().min(1).max(10_000),
  etag: z.string().min(1).max(512),
}).strict();
export const MultipartCompleteRequest = z.object({
  upload_id: z.string().min(1),
  parts: z.array(MultipartCompletedPart).min(2).max(10_000),
}).strict();
export const MultipartCompleteResponse = z.object({
  completed: z.literal(true),
  byte_size: z.number().int().min(1),
  sha256: Sha256Hex,
}).strict();

export type MultipartCreateResponseT = z.infer<typeof MultipartCreateResponse>;
export type MultipartCompletedPartT = z.infer<typeof MultipartCompletedPart>;
