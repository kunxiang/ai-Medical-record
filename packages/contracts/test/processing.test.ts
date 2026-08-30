import { describe, expect, it } from 'vitest';
import {
  CapabilitiesResponse, ProcessingJobEnvelope, ProcessingSuggestionEnvelope,
} from '../src/processing.js';

const uuid = '01990f89-5000-7000-8000-000000000001';
const sha = 'a'.repeat(64);

describe('processing core contracts', () => {
  it('off 模式拒绝伪造 assist capability', () => {
    expect(() => CapabilitiesResponse.parse({
      processing_mode: 'off',
      core: {
        document_metadata: true, keyword_search: true, context: true,
        observations: true, trends: true, exports: true,
      },
      assist: { available: true, plugins: [], capabilities: ['semantic_embed'] },
    })).toThrow();
  });

  it('job 在入队时冻结目标插件版本且 family 不绑定 person', () => {
    const parsed = ProcessingJobEnvelope.parse({
      id: uuid,
      capability: 'facility_suggest',
      target_plugin_id: 'deepseek',
      target_plugin_version: '1.0.0',
      subject_type: 'family',
      subject_id: 'family:default',
      person_id: null,
      input_revision: 0,
      input_sha256: sha,
      run_generation: 0,
    });
    expect(parsed.target_plugin_version).toBe('1.0.0');
  });

  it('suggestion 必须自带可复制到 L1 的 provenance', () => {
    const parsed = ProcessingSuggestionEnvelope.parse({
      id: uuid,
      capability: 'document_metadata_suggest',
      subject_type: 'document',
      subject_id: uuid,
      person_id: uuid,
      input_revision: 1,
      input_sha256: sha,
      payload: { title: '检查报告' },
      provenance: {
        plugin_id: 'deepseek', plugin_version: '1.0.0', provider: 'deepseek',
        model: 'vision', prompt_id: 'metadata', prompt_version: '1',
        artifact_key: null, artifact_sha256: null,
      },
      created_at: '2026-08-28T00:00:00.000Z',
    });
    expect(parsed.provenance.plugin_id).toBe('deepseek');
  });
});
