import { createHash, randomBytes } from 'node:crypto';

export function exportShareTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newExportShareToken(): string {
  return randomBytes(32).toString('base64url');
}
