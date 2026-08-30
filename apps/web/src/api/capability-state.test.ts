import { describe, expect, it } from 'vitest';
import { failClosedCapabilityState } from './capability-state.js';

describe('capability fail-closed', () => {
  it('发现请求失败时保留全部 core 能力并关闭全部 assist 能力', () => {
    const fallback = failClosedCapabilityState();
    expect(fallback.status).toBe('unknown');
    expect(Object.values(fallback.capabilities.core).every(Boolean)).toBe(true);
    expect(fallback.capabilities.assist).toEqual({ available: false, plugins: [], capabilities: [] });
  });
});
