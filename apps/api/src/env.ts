function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name},拒绝启动`);
  return v;
}

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://amr:amr@localhost:5433/amr',
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9100',
    region: process.env.S3_REGION ?? 'us-east-1',
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
};

export const LOCK_RETENTION_YEARS = 10;
export const PROBE_RETENTION_MS = 90 * 1000; // lock-probe 用最短可行保留(spec m0-04 §3)
