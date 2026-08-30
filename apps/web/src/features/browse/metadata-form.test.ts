import { describe, expect, it } from 'vitest';
import { buildMetadataPatch, selectableSuggestionFields, type MetadataForm } from './metadata-form.js';

const form: MetadataForm = {
  doc_type: 'lab_report', sampled_on: '2026-08-01', reported_on: '',
  facility_name_raw: '示例医院', department: '检验科', title: '血液检查', note: '',
};

describe('P0 人工元数据表单', () => {
  it('只提交 dirty 字段，保持 Merge Patch 的 omit/null 语义', () => {
    const patch = buildMetadataPatch({
      form, dirty: new Set(['title', 'note']), revision: 3,
      operationId: '018f47d2-4454-7d4b-8ad0-4cb96ad11a11',
    });
    expect(patch).toMatchObject({ if_revision: 3, title: '血液检查', note: null });
    expect('sampled_on' in patch).toBe(false);
    expect('facility_id' in patch).toBe(false);
  });

  it('编辑机构原文时明确清除旧标准机构引用', () => {
    const patch = buildMetadataPatch({
      form, dirty: new Set(['facility_name_raw']), revision: 0,
      operationId: '018f47d2-4454-7d4b-8ad0-4cb96ad11a12',
    });
    expect(patch.facility_id).toBeNull();
    expect(patch.facility_name_raw).toBe('示例医院');
  });

  it('建议选择器排除已经接受的字段', () => {
    const fields = selectableSuggestionFields({
      id: '018f47d2-4454-7d4b-8ad0-4cb96ad11a13',
      document_id: '018f47d2-4454-7d4b-8ad0-4cb96ad11a14',
      input_revision: 1,
      values: { title: '建议标题', department: '心内科' },
      provenance: {
        plugin_id: 'fixture', plugin_version: '1', provider: null, model: null, prompt_id: null,
        prompt_version: null, artifact_key: null, artifact_sha256: null,
      },
      state: 'partially_accepted', accepted_fields: ['title'],
      created_at: '2026-08-28T00:00:00.000Z', updated_at: '2026-08-28T00:00:00.000Z',
    });
    expect(fields).toEqual(['department']);
  });
});
