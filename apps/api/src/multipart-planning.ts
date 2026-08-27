import { createHash } from 'node:crypto';
import { MULTIPART_PART_BYTES } from '@amr/contracts';

export interface CompletedPartInput {
  part_number: number;
  etag: string;
}

export function multipartPartCount(byteSize: number): number {
  if (!Number.isInteger(byteSize) || byteSize < 1) throw new Error('文件大小无效');
  return Math.ceil(byteSize / MULTIPART_PART_BYTES);
}

export function orderedCompleteParts(
  parts: readonly CompletedPartInput[],
  expectedCount: number,
): CompletedPartInput[] {
  const ordered = [...parts].sort((a, b) => a.part_number - b.part_number);
  if (ordered.length !== expectedCount
      || ordered.some((part, index) => part.part_number !== index + 1)) {
    throw new Error('必须提交从 1 开始的完整连续分片清单');
  }
  return ordered;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** S3 lifecycle 或错误的分片清单会使既有 UploadId 无法继续；客户端应只重建该文件的 multipart。 */
export function shouldRestartMultipart(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
  return name === 'NoSuchUpload' || name === 'InvalidPart' || name === 'InvalidPartOrder';
}
