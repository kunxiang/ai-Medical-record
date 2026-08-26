import { describe, expect, it } from 'vitest';
import { missingPartNumbers, partByteRange, saveCompletedPart } from './multipart.js';

describe('multipart resume state', () => {
  it('刷新后只列出尚未完成的 part', () => {
    expect(missingPartNumbers(3, [
      { part_number: 1, etag: 'a' }, { part_number: 3, etag: 'c' },
    ])).toEqual([2]);
  });

  it('末片允许小于 8 MiB', () => {
    expect(partByteRange(2, 8, 12)).toEqual({ start: 8, end: 12 });
  });

  it('同一 part 重传覆盖旧 ETag 且保持排序', () => {
    expect(saveCompletedPart([
      { part_number: 2, etag: 'old' }, { part_number: 1, etag: 'a' },
    ], { part_number: 2, etag: 'new' })).toEqual([
      { part_number: 1, etag: 'a' }, { part_number: 2, etag: 'new' },
    ]);
  });
});
