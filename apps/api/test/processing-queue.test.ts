import { describe, expect, it } from 'vitest';
import { processingDedupKey } from '@amr/contracts';
import { DEFAULT_PROCESSING_LEASE_MS } from '../src/processing/constants.js';

describe('processing queue invariants', () => {
  const base = {
    capability: 'document_metadata_suggest' as const,
    targetPluginId: 'deepseek',
    targetPluginVersion: '1.0.0',
    subjectType: 'document' as const,
    subjectId: 'doc-1',
    inputSha256: 'a'.repeat(64),
    runGeneration: 0,
  };

  it('插件版本、输入与 generation 都进入 dedup identity', () => {
    const first = processingDedupKey(base);
    expect(processingDedupKey({ ...base, targetPluginVersion: '2.0.0' })).not.toBe(first);
    expect(processingDedupKey({ ...base, inputSha256: 'b'.repeat(64) })).not.toBe(first);
    expect(processingDedupKey({ ...base, runGeneration: 1 })).not.toBe(first);
  });

  it('默认 lease 为 15 分钟，防止 worker 崩溃永久 running', () => {
    expect(DEFAULT_PROCESSING_LEASE_MS).toBe(15 * 60_000);
  });
});
