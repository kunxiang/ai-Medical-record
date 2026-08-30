function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name},拒绝启动`);
  return v;
}

const processingMode = (() => {
  const value = process.env.PROCESSING_MODE ?? 'off';
  if (value !== 'off' && value !== 'assist') {
    throw new Error('PROCESSING_MODE 必须为 off 或 assist,拒绝启动');
  }
  return value as 'off' | 'assist';
})();

export const env = {
  /** 智能处理是可选插件；Core 缺省必须在完全关闭时可用。 */
  processingMode,
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://amr:amr@localhost:5433/amr',
  /** m2-04 §3.5:作业并发度,必须 ≥1 */
  aiJobConcurrency: Number(process.env.AI_JOB_CONCURRENCY ?? '2'),
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9100',
    // R2 要求 region='auto';MinIO/S3 用 us-east-1。签名区域不匹配直接 SignatureDoesNotMatch,
    // 而错误信息完全不提区域 —— 值得自动推断而不是让人踩一次。
    region:
      process.env.S3_REGION ??
      ((process.env.S3_ENDPOINT ?? '').includes('r2.cloudflarestorage.com') ? 'auto' : 'us-east-1'),
    bucket: process.env.S3_BUCKET ?? 'medical-record',
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'amr-app',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'amr-app-secret',
    // 客户端直传要用的对外可达 endpoint(容器内外不同时区分)
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? 'http://localhost:9100',
  },
  authSecret: (() => {
    const s = req('AUTH_SECRET');
    if (Buffer.byteLength(s, 'utf-8') < 32) throw new Error('AUTH_SECRET 必须 ≥ 32 字节,拒绝启动');
    return s;
  })(),
  port: Number(process.env.PORT ?? 8300),
  // CORS 白名单(m1-02 §7.1)。禁止 '*':带 Authorization 的跨源请求需要精确 origin。
  webOrigins: (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',').map((o) => o.trim()).filter(Boolean),
  exports: {
    maxOriginalBytes: Number(process.env.EXPORT_MAX_ORIGINAL_BYTES ?? String(50 * 1024 * 1024)),
    maxOriginalPages: Number(process.env.EXPORT_MAX_ORIGINAL_PAGES ?? '100'),
    workerConcurrency: Number(process.env.EXPORT_WORKER_CONCURRENCY ?? '1'),
    leaseMs: Number(process.env.EXPORT_LEASE_MS ?? String(2 * 60_000)),
  },
};

export const LOCK_RETENTION_YEARS = 10;
export const PROBE_RETENTION_MS = 90 * 1000; // lock-probe 用最短可行保留(spec m0-04 §3)
