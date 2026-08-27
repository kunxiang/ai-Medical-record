export interface SavedPart {
  part_number: number;
  etag: string;
}

export function missingPartNumbers(partCount: number, saved: readonly SavedPart[]): number[] {
  const completed = new Set(saved.map((part) => part.part_number));
  return Array.from({ length: partCount }, (_, index) => index + 1)
    .filter((partNumber) => !completed.has(partNumber));
}

export function partByteRange(
  partNumber: number,
  partSize: number,
  byteSize: number,
): { start: number; end: number } {
  const start = (partNumber - 1) * partSize;
  return { start, end: Math.min(start + partSize, byteSize) };
}

export function saveCompletedPart(saved: readonly SavedPart[], part: SavedPart): SavedPart[] {
  return [...saved.filter((current) => current.part_number !== part.part_number), part]
    .sort((a, b) => a.part_number - b.part_number);
}
