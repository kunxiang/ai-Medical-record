import { webcrypto as crypto } from 'node:crypto';
import { SLUG_ALPHABET } from '@amr/contracts';

// spec m0-03 §1:CSPRNG + rejection sampling(30 不整除 256,取模有偏)
function randomChars(n: number): string {
  const out: string[] = [];
  const buf = new Uint8Array(64);
  while (out.length < n) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      // 接受 [0, 240):240 = 8×30,均匀映射;拒绝 [240, 256)
      if (b < 240 && out.length < n) out.push(SLUG_ALPHABET[b % 30]!);
    }
  }
  return out.join('');
}

export function newPersonSlug(): string {
  return 'p' + randomChars(5);
}
export function newDocShortId(): string {
  return 'd' + randomChars(5);
}
