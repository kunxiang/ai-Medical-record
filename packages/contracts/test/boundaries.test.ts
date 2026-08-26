import { describe, expect, it } from 'vitest';
import { CaptureSidecar, CorrectionPageMove, DocumentCreate } from '../src/index.js';

const accountId = '01990f89-5000-7000-8000-000000000001';
const documentId = '01990f89-5000-7000-8000-000000000002';
const operationId = '01990f89-5000-7000-8000-000000000003';

describe('document boundary contracts', () => {
  it('允许服务端 split capture 跨前缀引用原件', () => {
    const capture = CaptureSidecar.parse({
      schema_version: '2.0', document_id: documentId, short_id: 'd23456',
      person: { slug: 'p23456', name: '测试人员', confirmed_by: 'api' },
      captured_at: '2026-08-26T08:00:00Z', capture_date: '2026-08-26', source: 'split',
      uploaded_by: accountId, client_document_id: `split:${operationId}`,
      original_filename: null,
      pages: [{
        page_no: 1, capture_order: 2,
        file: 'people/p23456/2026/2026-08-26__d34567/page-02.jpg',
        sha256: 'a'.repeat(64), bytes: 42, mime: 'image/jpeg', width: 10, height: 20,
      }],
      created_at: '2026-08-26T08:01:00Z',
    });
    expect(capture.source).toBe('split');
    expect(capture.pages[0]!.file).toContain('__d34567/');
  });

  it('上传登记不能伪造 split 来源', () => {
    const result = DocumentCreate.safeParse({
      person_id: accountId, person_confirmed: true, confirmed_by: 'api',
      batch_id: documentId, source: 'split', captured_at: '2026-08-26T08:00:00Z',
      client_document_id: 'client-document-1',
      pages: [{
        upload_id: operationId, page_no: 1, capture_order: 1,
        width: 10, height: 20, sha256: 'a'.repeat(64), exif: null,
      }],
    });
    expect(result.success).toBe(false);
  });

  it('page_move 用摘要和操作 ID 固化幂等移动', () => {
    expect(CorrectionPageMove.parse({
      schema_version: '1.1', kind: 'page_move', seq: 1,
      corrected_at: '2026-08-26T08:01:00Z', client_operation_id: operationId,
      from_doc_short_id: 'd23456', to_doc_short_id: 'd34567',
      page_sha256: 'a'.repeat(64), from_page_no: 2, to_page_no: 1,
    }).client_operation_id).toBe(operationId);
  });
});
