import { beforeAll, describe, expect, it } from 'vitest';
import type { ProcessingCapabilityT } from '@amr/contracts';
import { ACTIVE_PLUGIN_MAX_AGE_MS } from '../src/processing/constants.js';

let buildCapabilities: typeof import('../src/routes/capabilities.js').buildCapabilities;

const plugin = {
  pluginId: 'legacy-ai',
  pluginVersion: 'm2-v1',
  capabilities: ['document_metadata_suggest', 'facility_suggest'] as ProcessingCapabilityT[],
  lastHeartbeatAt: new Date('2026-08-28T00:00:00.000Z'),
  metadata: { runtime: 'test' },
};

describe('capability discovery', () => {
  beforeAll(async () => {
    process.env.AUTH_SECRET = 'test-auth-secret-that-is-at-least-32-bytes';
    ({ buildCapabilities } = await import('../src/routes/capabilities.js'));
  });

  it('off 模式即使数据库残留心跳也只返回 core 能力', () => {
    const result = buildCapabilities('off', [plugin]);
    expect(result.assist).toEqual({ available: false, plugins: [], capabilities: [] });
    expect(Object.values(result.core).every(Boolean)).toBe(true);
  });

  it('assist 模式稳定合并有效插件声明的能力', () => {
    const result = buildCapabilities('assist', [plugin]);
    expect(result.assist.available).toBe(true);
    expect(result.assist.capabilities).toEqual(['document_metadata_suggest', 'facility_suggest']);
    expect(result.assist.plugins[0]?.plugin_id).toBe('legacy-ai');
  });

  it('心跳有效窗口固定为 90 秒', () => {
    expect(ACTIVE_PLUGIN_MAX_AGE_MS).toBe(90_000);
  });
});
