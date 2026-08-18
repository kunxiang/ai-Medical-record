import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { ApiError } from './errors.js';
import { verifyToken } from './auth.js';

// spec m0-01 §7.3:全部路由必须经 defineRoute 注册,校验单点实施。
// CI 以 grep 断言无裸注册(99 B7)。

export interface RouteCtx<In> {
  input: In;
  accountId: string;
  req: FastifyRequest;
  /** 覆盖本次响应状态码(如幂等命中 201 路由返回 200) */
  setStatus: (code: number) => void;
}


export function defineRoute<InS extends z.ZodTypeAny, OutS extends z.ZodTypeAny>(
  app: FastifyInstance,
  opts: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    input: InS;
    output: OutS;
    /** 'none' 仅用于 login */
    auth?: 'bearer' | 'none';
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
        if (!h?.startsWith('Bearer ')) throw new ApiError('unauthenticated', '缺少凭证');
        accountId = await verifyToken(h.slice(7));
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
        input: parsed.data, accountId, req,
        setStatus: (code) => { statusOverride = code; },
      });
      reply.status(statusOverride ?? opts.status ?? 200);
      return opts.output.parse(out);
    },
  });
}
