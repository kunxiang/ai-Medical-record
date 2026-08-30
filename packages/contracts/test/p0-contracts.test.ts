import { describe, expect, it } from 'vitest';
import {
  DocumentListQuery, DocumentMetadataPatch, EncounterCreate,
  MetadataMigrationBatchAcceptRequest, MetadataSuggestionAcceptRequest, SearchQuery,
  decodeDocumentCursor, encodeDocumentCursor,
} from '../src/index.js';

const id = '018f0000-0000-7000-8000-000000000001';

describe('P0 contracts', () => {
  it('文档列表默认使用 best_available，支持五种日期语义', () => {
    expect(DocumentListQuery.parse({ person_id: id }).date_field).toBe('best_available');
    for (const date_field of ['best_available', 'sampled', 'reported', 'encounter', 'capture']) {
      expect(DocumentListQuery.parse({ person_id: id, date_field }).date_field).toBe(date_field);
    }
  });

  it('query boolean 严格区分字符串 false 与 true', () => {
    expect(DocumentListQuery.parse({ person_id: id, include_archived: 'false', acked: 'false' }))
      .toMatchObject({ include_archived: false, acked: false });
    expect(DocumentListQuery.parse({ person_id: id, include_archived: 'true' }).include_archived).toBe(true);
  });

  it('文档游标冻结 date_field 与三元排序键', () => {
    const value = {
      selectedDate: '2026-08-28', capturedAt: '2026-08-28T00:00:00.000Z',
      documentId: id, dateField: 'reported' as const,
    };
    const cursor = encodeDocumentCursor(value);
    expect(cursor.length).toBeGreaterThan(128);
    expect(DocumentListQuery.parse({ person_id: id, cursor }).cursor).toBe(cursor);
    expect(decodeDocumentCursor(cursor)).toEqual(value);
  });

  it('metadata Merge Patch 区分省略与显式 null', () => {
    const patch = DocumentMetadataPatch.parse({
      client_operation_id: id, if_revision: 2, title: null,
    });
    expect(patch).toHaveProperty('title', null);
    expect(patch).not.toHaveProperty('note');
  });

  it('encounter/search 拒绝未知字段并限制查询模式', () => {
    expect(() => EncounterCreate.parse({
      client_operation_id: id, encounter_type: 'outpatient', occurred_on: '2026-08-28', extra: true,
    })).toThrow();
    expect(SearchQuery.parse({ person_id: id, q: '血脂' }).mode).toBe('keyword');
  });

  it('metadata suggestion 单条和批量接受都拒绝重复字段', () => {
    expect(() => MetadataSuggestionAcceptRequest.parse({
      client_operation_id: id, if_revision: 1, fields: ['title', 'title'],
    })).toThrow();
    expect(() => MetadataMigrationBatchAcceptRequest.parse({
      items: [{
        document_id: id, suggestion_id: id, client_operation_id: id,
        if_revision: 1, fields: ['department', 'department'],
      }],
    })).toThrow();
  });
});
