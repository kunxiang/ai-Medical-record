// tools 共用的 S3 客户端。管理凭证(建桶/策略)与应用凭证分离(spec m0-04 §4.4)。
import { S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';

export const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:9100';
export const BUCKET = process.env.S3_BUCKET ?? 'medical-record';

// MinIO 对新版 SDK 默认附加的 CRC32 校验和头返回 501 NotImplemented。
// 'WHEN_REQUIRED' 只在显式指定(如上传时的 ChecksumSHA256)时发送 —— 上传链的
// 校验和语义不受影响(m0-06 §2)。
const CHECKSUM_COMPAT = { requestChecksumCalculation: 'WHEN_REQUIRED' as const };

/**
 * MinIO 对桶配置类操作(lifecycle/cors/encryption)只接受 Content-MD5,
 * 而新版 AWS SDK 强制附加 x-amz-checksum-crc32 → 501 NotImplemented。
 * 该中间件在发送前剥掉 flexible checksum 头并补上 Content-MD5。
 * 仅影响桶配置类请求;对象上传的 ChecksumSHA256 语义不受影响。
 */
function applyMinioBucketConfigCompat(client: S3Client): S3Client {
  client.middlewareStack.add(
    (next) => async (args) => {
      const req = args.request as { headers?: Record<string, string>; body?: unknown };
      const headers = req.headers ?? {};
      const hasFlexible = Object.keys(headers).some((h) => h.toLowerCase().startsWith('x-amz-checksum-'));
      if (hasFlexible && typeof req.body === 'string') {
        for (const h of Object.keys(headers)) {
          const l = h.toLowerCase();
          if (l.startsWith('x-amz-checksum-') || l === 'x-amz-sdk-checksum-algorithm') delete headers[h];
        }
        headers['Content-MD5'] = createHash('md5').update(req.body, 'utf-8').digest('base64');
      }
      return next(args);
    },
    // ★ 必须在 build 步:finalizeRequest 里签名已完成,此后加的头不进签名 → AccessDenied
    { step: 'build', name: 'minioBucketConfigCompat', priority: 'low' },
  );
  return client;
}

export function adminClient(): S3Client {
  return applyMinioBucketConfigCompat(new S3Client({
    ...CHECKSUM_COMPAT,
    endpoint: ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ADMIN_KEY ?? 'amr-admin',
      secretAccessKey: process.env.S3_ADMIN_SECRET ?? 'amr-admin-secret',
    },
  }));
}

export function appClient(): S3Client {
  return new S3Client({
    ...CHECKSUM_COMPAT,
    endpoint: ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? 'amr-app',
      secretAccessKey: process.env.S3_SECRET_KEY ?? 'amr-app-secret',
    },
  });
}
