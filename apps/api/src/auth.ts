import { SignJWT, jwtVerify } from 'jose';
import { verify as argonVerify, hash as argonHash } from '@node-rs/argon2';
import { env } from './env.js';
import { ApiError } from './errors.js';

const secret = new TextEncoder().encode(env.authSecret);

// spec m0-05 §1:argon2id m=64MiB t=3 p=4
export const ARGON_OPTS = { memoryCost: 65536, timeCost: 3, parallelism: 4 } as const;
export const hashPassword = (pw: string) => argonHash(pw, ARGON_OPTS);
export const verifyPassword = (hash: string, pw: string) => argonVerify(hash, pw);

export async function signToken(accountId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret);
}

export async function verifyToken(token: string): Promise<string> {
  try {
    // 算法白名单锁死 HS256,leeway 60s(spec m0-05 §2)
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
      clockTolerance: 60,
    });
    if (!payload.sub) throw new Error('no sub');
    return payload.sub;
  } catch {
    throw new ApiError('unauthenticated', '认证失败');
  }
}

// spec m0-05 §1:固定窗口限流,单实例内存,键 = 直连对端 IP
const windows = new Map<string, { windowStart: number; count: number }>();
export function checkLoginRateLimit(ip: string, now = Date.now()): void {
  const w = windows.get(ip);
  if (!w || now - w.windowStart >= 60_000) {
    windows.set(ip, { windowStart: now, count: 1 });
    return;
  }
  w.count += 1;
  if (w.count > 10) throw new ApiError('rate_limited', '尝试过于频繁,请稍后再试');
}
