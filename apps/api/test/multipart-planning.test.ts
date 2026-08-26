import { describe, expect, it } from 'vitest';
import {
  multipartPartCount, orderedCompleteParts, sha256Hex, shouldRestartMultipart,
} from '../src/multipart-planning.js';

describe('multipart deterministic planning', () => {
  it('12 MiB 固定拆成两个 8 MiB part', () => {
    expect(multipartPartCount(12 * 1024 * 1024)).toBe(2);
  });

  it('complete 清单排序后必须从 1 连续', () => {
    expect(orderedCompleteParts([
      { part_number: 2, etag: 'b' }, { part_number: 1, etag: 'a' },
    ], 2).map((part) => part.part_number)).toEqual([1, 2]);
    expect(() => orderedCompleteParts([{ part_number: 2, etag: 'b' }], 2)).toThrow('连续');
  });

  it('整文件摘要使用原始合并字节', () => {
    expect(sha256Hex(Buffer.from('abc')))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('只把不可继续的 S3 multipart 错误归为重建', () => {
    expect(shouldRestartMultipart({ name: 'NoSuchUpload' })).toBe(true);
    expect(shouldRestartMultipart({ name: 'InvalidPart' })).toBe(true);
    expect(shouldRestartMultipart({ name: 'TimeoutError' })).toBe(false);
  });
});
