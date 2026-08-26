export interface BoundaryPage {
  id: string;
  pageNo: number;
  contentSha256: string;
  captureOrder: number;
}

export interface PageMovePlan {
  pageId: string;
  pageSha256: string;
  fromPageNo: number;
  toPageNo: number;
  captureOrder: number;
}

function ordered(pages: readonly BoundaryPage[]): BoundaryPage[] {
  const result = [...pages].sort((a, b) => a.pageNo - b.pageNo);
  if (result.some((page, index) => page.pageNo !== index + 1)) {
    throw new Error('文档页号不是从 1 开始的连续序列');
  }
  return result;
}

export function planSplit(
  pages: readonly BoundaryPage[],
  atPageNo: number,
): PageMovePlan[] {
  const source = ordered(pages);
  if (!Number.isInteger(atPageNo) || atPageNo < 2 || atPageNo > source.length) {
    throw new Error('拆分页号必须位于第 2 页到最后一页之间');
  }
  return source.slice(atPageNo - 1).map((page, index) => ({
    pageId: page.id,
    pageSha256: page.contentSha256,
    fromPageNo: page.pageNo,
    toPageNo: index + 1,
    captureOrder: page.captureOrder,
  }));
}

export function planMerge(
  sourcePages: readonly BoundaryPage[],
  targetPageCount: number,
): PageMovePlan[] {
  const source = ordered(sourcePages);
  if (!Number.isInteger(targetPageCount) || targetPageCount < 1) {
    throw new Error('目标文档必须至少有一页');
  }
  return source.map((page, index) => ({
    pageId: page.id,
    pageSha256: page.contentSha256,
    fromPageNo: page.pageNo,
    toPageNo: targetPageCount + index + 1,
    captureOrder: page.captureOrder,
  }));
}

export function planMovePage(
  sourcePages: readonly BoundaryPage[],
  pageNo: number,
  targetPageCount: number,
): PageMovePlan {
  const source = ordered(sourcePages);
  if (source.length < 2) throw new Error('单页文档不能通过 move-page 变为空文档，请使用 merge');
  if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > source.length) {
    throw new Error('待移动页不存在');
  }
  if (!Number.isInteger(targetPageCount) || targetPageCount < 1) {
    throw new Error('目标文档必须至少有一页');
  }
  const page = source[pageNo - 1]!;
  return {
    pageId: page.id,
    pageSha256: page.contentSha256,
    fromPageNo: page.pageNo,
    toPageNo: targetPageCount + 1,
    captureOrder: page.captureOrder,
  };
}
