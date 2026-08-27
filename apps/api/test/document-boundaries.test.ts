import { describe, expect, it } from 'vitest';
import { planMerge, planMovePage, planSplit } from '../src/document-boundaries.js';

const pages = [
  { id: 'a', pageNo: 1, contentSha256: '1'.repeat(64), captureOrder: 3 },
  { id: 'b', pageNo: 2, contentSha256: '2'.repeat(64), captureOrder: 1 },
  { id: 'c', pageNo: 3, contentSha256: '3'.repeat(64), captureOrder: 2 },
];

describe('document boundary planning', () => {
  it('split 重新从 1 编号，但保持拍摄顺序事实', () => {
    expect(planSplit(pages, 2)).toEqual([
      { pageId: 'b', pageSha256: '2'.repeat(64), fromPageNo: 2, toPageNo: 1, captureOrder: 1 },
      { pageId: 'c', pageSha256: '3'.repeat(64), fromPageNo: 3, toPageNo: 2, captureOrder: 2 },
    ]);
  });

  it('merge 将源页连续追加到目标尾部', () => {
    expect(planMerge(pages, 4).map((move) => move.toPageNo)).toEqual([5, 6, 7]);
  });

  it('move-page 只规划一页并拒绝清空单页文档', () => {
    expect(planMovePage(pages, 2, 3).toPageNo).toBe(4);
    expect(() => planMovePage([pages[0]!], 1, 2)).toThrow('merge');
  });

  it('拒绝非连续源页，避免把已有损坏静默固化', () => {
    expect(() => planSplit([pages[0]!, { ...pages[2]!, pageNo: 4 }], 2)).toThrow('连续序列');
  });
});
