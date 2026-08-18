// tools 共用的 S3 客户端。管理凭证(建桶/策略)与应用凭证分离(spec m0-04 §4.4)。
import { S3Client } from '@aws-sdk/client-s3';

export const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:9100';
export const BUCKET = process.env.S3_BUCKET ?? 'medical-record';

// MinIO 对新版 SDK 默认附加的 CRC32 校验和头返回 501 NotImplemented。
// 'WHEN_REQUIRED' 只在显式指定(如上传时的 ChecksumSHA256)时发送 —— 上传链的
// 校验和语义不受影响(m0-06 §2)。
const CHECKSUM_COMPAT = { requestChecksumCalculation: 'WHEN_REQUIRED' as const };

export function adminClient(): S3Client {
  return new S3Client({
    ...CHECKSUM_COMPAT,
    endpoint: ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ADMIN_KEY ?? 'amr-admin',
      secretAccessKey: process.env.S3_ADMIN_SECRET ?? 'amr-admin-secret',
    },
  });
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
