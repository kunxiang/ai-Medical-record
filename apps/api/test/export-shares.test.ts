import { describe, expect, it } from 'vitest';
import { exportShareTokenHash, newExportShareToken } from '../src/exports/share-token.js';

describe('P4 public export share token', () => {
  it('persists only a one-way SHA-256 hash', () => {
    const token = newExportShareToken();
    const hash = exportShareTokenHash(token);
    expect(token).toHaveLength(43);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(exportShareTokenHash(token)).toBe(hash);
  });
});
