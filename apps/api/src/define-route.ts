import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { ApiError } from './errors.js';
import { verifyToken } from './auth.js';
import { db } from './db/client.js';
import { account } from './db/schema.js';

// spec m0-01 §7.3:全部路由必须经 defineRoute 注册,校验单点实施。
// CI 以 grep 断言无裸注册(99 B7)。

export interface RouteCtx<In> {
  input: In;
  accountId: string;
  req: FastifyRequest;
  /** 覆盖本次响应状态码(如幂等命中 201 路由返回 200) */
  setStatus: (code: number) => void;
  reply: FastifyReply;
}


export function defineRoute<InS extends z.ZodTypeAny, OutS extends z.ZodTypeAny>(
  app: FastifyInstance,
  opts: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    input: InS;
    output: OutS;
    /** 'none' 仅用于 login;'bearer-or-query' 仅用于派生物端点(<img> 无法带头,见 m1/CHANGES #1) */
    auth?: 'bearer' | 'bearer-or-query' | 'none';
    status?: number;
    handler: (ctx: RouteCtx<z.infer<InS>>) => Promise<unknown>;
  },
): void {
  app.route({
    method: opts.method,
    url: opts.url,
    handler: async (req, reply) => {
      let accountId = '';
      if (opts.auth !== 'none') {
        const h = req.headers.authorization;
        let raw: string | undefined;
        if (h?.startsWith('Bearer ')) raw = h.slice(7);
        else if (opts.auth === 'bearer-or-query') {
          const q = (req.query as Record<string, unknown>)['access_token'];
          if (typeof q === 'string') raw = q;
        }
        if (!raw) throw new ApiError('unauthenticated', '缺少凭证');
        const claims = await verifyToken(raw);
        // D12(m1-02 §6):epoch 与库中不符 ⇒ 该 token 已被改密码作废
        const rows = await db
          .select({ epoch: account.tokenEpoch })
          .from(account)
          .where(eq(account.id, claims.accountId))
          .limit(1);
        if (!rows[0] || rows[0].epoch !== claims.epoch) {
          throw new ApiError('unauthenticated', '凭证已失效');
        }
        accountId = claims.accountId;
      }
      const raw = {
        ...(req.params as Record<string, unknown>),
        ...(req.query as Record<string, unknown>),
        ...(typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {}),
      };
      const parsed = opts.input.safeParse(raw);
      if (!parsed.success) {
        throw new ApiError('validation_failed', '入参校验失败', { issues: parsed.error.issues });
      }
      let statusOverride: number | null = null;
      const out = await opts.handler({
        input: parsed.data, accountId, req, reply,
        setStatus: (code) => { statusOverride = code; },
      });
      if (reply.sent || reply.raw.headersSent) return reply;   // handler 已自行响应(如 302)
      reply.status(statusOverride ?? opts.status ?? 200);
      return opts.output.parse(out);
    },
  });
}
