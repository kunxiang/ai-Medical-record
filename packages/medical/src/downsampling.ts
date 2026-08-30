export const LTTB_VERSION = 'lttb@1';

export interface LttbPoint {
  x: number;
  y: number;
}

/**
 * Fixed-version Largest-Triangle-Three-Buckets. Input order is preserved and
 * ties select the earliest point, making repeated runs byte-for-byte stable.
 */
export function largestTriangleThreeBuckets<T extends LttbPoint>(
  input: readonly T[], threshold: number,
): T[] {
  if (!Number.isInteger(threshold) || threshold < 3) {
    throw new Error('LTTB threshold must be an integer >= 3');
  }
  if (threshold >= input.length || input.length <= 2) return [...input];

  const sampled: T[] = [input[0]!];
  const bucketWidth = (input.length - 2) / (threshold - 2);
  let selectedIndex = 0;

  for (let bucket = 0; bucket < threshold - 2; bucket += 1) {
    const averageStart = Math.floor((bucket + 1) * bucketWidth) + 1;
    const averageEnd = Math.min(Math.floor((bucket + 2) * bucketWidth) + 1, input.length);
    let averageX = 0;
    let averageY = 0;
    const averageCount = Math.max(averageEnd - averageStart, 1);
    if (averageStart < input.length) {
      for (let index = averageStart; index < averageEnd; index += 1) {
        averageX += input[index]!.x;
        averageY += input[index]!.y;
      }
      averageX /= averageCount;
      averageY /= averageCount;
    } else {
      averageX = input[input.length - 1]!.x;
      averageY = input[input.length - 1]!.y;
    }

    const rangeStart = Math.floor(bucket * bucketWidth) + 1;
    const rangeEnd = Math.min(Math.floor((bucket + 1) * bucketWidth) + 1, input.length - 1);
    const anchor = input[selectedIndex]!;
    let maxArea = -1;
    let nextIndex = rangeStart;
    for (let index = rangeStart; index < rangeEnd; index += 1) {
      const candidate = input[index]!;
      const area = Math.abs(
        (anchor.x - averageX) * (candidate.y - anchor.y)
        - (anchor.x - candidate.x) * (averageY - anchor.y),
      );
      if (area > maxArea) {
        maxArea = area;
        nextIndex = index;
      }
    }
    sampled.push(input[nextIndex]!);
    selectedIndex = nextIndex;
  }
  sampled.push(input[input.length - 1]!);
  return sampled;
}
