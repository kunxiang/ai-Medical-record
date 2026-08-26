import { describe, expect, it } from 'vitest';
import {
  MULTIPART_PART_BYTES, MultipartCompleteRequest, MultipartCreateResponse,
  MultipartSignRequest, PresignResponse,
} from '../src/index.js';

const fileId = '01990f89-5000-7000-8000-000000000001';

describe('multipart contracts', () => {
  it('大文件 presign 不下发可绕过 multipart 的单 PUT URL', () => {
    const result = PresignResponse.parse({
      batch_id: fileId, doc_short_id: 'd23456',
      uploads: [{
        upload_id: fileId, mode: 'multipart', url: null, method: 'PUT',
        headers: {}, expires_at: null,
      }],
    });
    expect(result.uploads[0]!.url).toBeNull();
  });

  it('固定分片大小为 8 MiB', () => {
    expect(MultipartCreateResponse.parse({
      upload_id: 'opaque', key: '_incoming/a/b', part_size: MULTIPART_PART_BYTES, part_count: 2,
    }).part_size).toBe(8 * 1024 * 1024);
  });

  it('sign 拒绝重复 part，complete 保留 ETag', () => {
    expect(MultipartSignRequest.safeParse({ upload_id: 'u', part_numbers: [1, 1] }).success).toBe(false);
    expect(MultipartCompleteRequest.parse({
      upload_id: 'u', parts: [
        { part_number: 1, etag: '"a"' }, { part_number: 2, etag: '"b"' },
      ],
    }).parts[1]!.etag).toBe('"b"');
  });
});
