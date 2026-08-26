import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  assertPdfPageLimit, MAX_PDF_BYTES, pdfPageCount, PdfStage1Error,
} from '../src/pdf-stage1.js';

async function makePdf(pageCount: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) pdf.addPage([100, 100]);
  return Buffer.from(await pdf.save({ useObjectStreams: true }));
}

describe('Stage 1 PDF guard', () => {
  it('可靠读取压缩 PDF 的内部物理页数', async () => {
    expect(await pdfPageCount(await makePdf(3))).toBe(3);
  });

  it('损坏 PDF 直接进入 unsupported，不交给 worker 重试', async () => {
    await pdfPageCount(Buffer.from('not a pdf')).catch((error: PdfStage1Error) => {
      expect(error.code).toBe('invalid_pdf');
    });
  });

  it('超过 600 页直接进入 unsupported', () => {
    expect(() => assertPdfPageLimit(601)).toThrow(PdfStage1Error);
    try {
      assertPdfPageLimit(601);
    } catch (error) {
      expect((error as PdfStage1Error).code).toBe('pdf_too_many_pages');
    }
  });

  it('PDF 字节上限固定为 32 MiB', () => {
    expect(MAX_PDF_BYTES).toBe(32 * 1024 * 1024);
  });
});
