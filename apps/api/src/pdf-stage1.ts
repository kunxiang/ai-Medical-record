import { PDFDocument } from 'pdf-lib';

export const MAX_PDF_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_PAGES = 600;

export class PdfStage1Error extends Error {
  constructor(readonly code: 'invalid_pdf' | 'pdf_too_many_pages', message: string) {
    super(message);
  }
}

export async function pdfPageCount(bytes: Buffer): Promise<number> {
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const count = pdf.getPageCount();
    if (count < 1) throw new Error('empty pdf');
    return count;
  } catch {
    throw new PdfStage1Error('invalid_pdf', 'PDF 文件损坏、加密或无法解析');
  }
}

export function assertPdfPageLimit(pageCount: number): void {
  if (pageCount > MAX_PDF_PAGES) {
    throw new PdfStage1Error('pdf_too_many_pages', 'PDF 超过 600 页上限');
  }
}
