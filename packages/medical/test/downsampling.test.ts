import { describe, expect, it } from 'vitest';
import { LTTB_VERSION, largestTriangleThreeBuckets } from '../src/index.js';

describe('fixed-version LTTB', () => {
  const points = Array.from({ length: 100 }, (_, index) => ({
    id: index, x: index, y: index === 50 ? 100 : Math.sin(index / 10),
  }));

  it('is deterministic, preserves endpoints and keeps the dominant spike', () => {
    const first = largestTriangleThreeBuckets(points, 12);
    const second = largestTriangleThreeBuckets(points, 12);
    expect(first).toEqual(second);
    expect(first).toHaveLength(12);
    expect(first[0]?.id).toBe(0);
    expect(first.at(-1)?.id).toBe(99);
    expect(first.some((point) => point.id === 50)).toBe(true);
    expect(LTTB_VERSION).toBe('lttb@1');
  });

  it('returns the original ordered points below the threshold', () => {
    expect(largestTriangleThreeBuckets(points.slice(0, 3), 3)).toEqual(points.slice(0, 3));
  });

  it('rejects thresholds that cannot preserve both endpoints and an interior point', () => {
    expect(() => largestTriangleThreeBuckets(points, 2)).toThrow();
  });
});
