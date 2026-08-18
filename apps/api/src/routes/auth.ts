import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { LoginRequest, LoginResponse } from '@amr/contracts';
import { checkLoginRateLimit, signToken, verifyPassword } from '../auth.js';
import { db } from '../db/client.js';
import { account } from '../db/schema.js';
import { defineRoute } from '../define-route.js';
import { ApiError } from '../errors.js';

export function registerAuthRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/auth/login',
    input: LoginRequest,
    output: LoginResponse,
    auth: 'none',
    handler: async ({ input, req }) => {
      checkLoginRateLimit(req.ip);
      // 失败一律 401,不区分"用户不存在/密码错"(spec m0-05 §1);
      // 用户不存在时也跑一次 verify(恒定代价的朴素形态,不作验收项)
      const rows = await db.select().from(account).where(eq(account.email, input.email.toLowerCase())).limit(1);
      const acct = rows[0];
      const hash =
        acct?.passwordHash ??
        '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const ok = await verifyPassword(hash, input.password).catch(() => false);
      if (!acct || !ok) throw new ApiError('unauthenticated', '认证失败');
      return { access_token: await signToken(acct.id, acct.tokenEpoch) };
    },
  });
}
