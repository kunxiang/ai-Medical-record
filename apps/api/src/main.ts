import { env } from './env.js';
import { startupProbe } from './s3.js';
import { buildServer } from './server.js';

const app = buildServer();
await startupProbe(); // 任一断言失败即拒绝启动(spec m0-04 §3)
await app.listen({ port: env.port, host: '0.0.0.0' });
console.log(`api listening on :${env.port}`);
