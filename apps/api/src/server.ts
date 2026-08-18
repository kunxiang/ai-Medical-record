import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ApiError } from './errors.js';
import { env } from './env.js';
import { initSharp } from './derivatives.js';
import { registerBrowseRoutes } from './routes/browse.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerPeopleRoutes } from './routes/people.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { armCrashPoint, InjectedCrash } from './test-hooks.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

  initSharp();   // 进程级全局,启动时设一次(m1-03 §2)

  // CORS(m1-02 §7.1):白名单来自 env,禁止 *,不用 cookie
  void app.register(cors, {
    origin: env.webOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization'],
    exposedHeaders: ['X-Amr-Generated'],
    credentials: false,
    maxAge: 600,
  });

  // A8 崩溃注入:仅 M0_TEST_HOOKS=1 时启用(spec m0-99 A8)
  if (process.env.M0_TEST_HOOKS === '1') {
    app.addHook('onRequest', async (req) => {
      const point = req.headers['x-m0-crash-after'];
      armCrashPoint(typeof point === 'string' ? point : null);
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }
    if (err instanceof InjectedCrash) {
      // 验收脚本的注入崩溃:以 500 结束本请求,模拟进程中断后的重试
      return reply.status(500).send({ error: { code: 'internal_error', message: 'injected crash' } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'internal_error', message: '服务器内部错误' } });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: '资源不存在' } }),
  );

  registerAuthRoutes(app);
  registerPeopleRoutes(app);
  registerDocumentRoutes(app);
  registerBrowseRoutes(app);
  return app;
}
