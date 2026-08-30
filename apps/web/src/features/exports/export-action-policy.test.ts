import { describe, expect, it } from 'vitest';
import { exportActionPolicy } from './export-action-policy.js';

describe('P4 export Web role and recovery states', () => {
  it('keeps viewers on completed internal downloads only', () => {
    expect(exportActionPolicy('viewer', {
      state: 'done', artifact_available: true, stale: true,
    })).toEqual({
      canDownload: true, canRetry: false, canRegenerateStale: false, canShare: false,
    });
  });

  it('lets editors retry failures or missing objects and rebuild stale exports', () => {
    expect(exportActionPolicy('editor', {
      state: 'failed', artifact_available: false, stale: false,
    }).canRetry).toBe(true);
    expect(exportActionPolicy('editor', {
      state: 'done', artifact_available: false, stale: true,
    })).toEqual({
      canDownload: false, canRetry: true, canRegenerateStale: true, canShare: false,
    });
  });

  it('allows only owners to share a completed artifact', () => {
    expect(exportActionPolicy('owner', {
      state: 'done', artifact_available: true, stale: false,
    }).canShare).toBe(true);
    expect(exportActionPolicy(null, {
      state: 'done', artifact_available: true, stale: false,
    })).toEqual({
      canDownload: false, canRetry: false, canRegenerateStale: false, canShare: false,
    });
  });
});
