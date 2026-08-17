// spec m0-04 §1:幂等建桶 + 自检。第二次运行无变更退出 0(99 A1)。
import {
  CreateBucketCommand, GetBucketEncryptionCommand, GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand, GetObjectLockConfigurationCommand, GetPublicAccessBlockCommand,
  HeadBucketCommand, PutBucketEncryptionCommand, PutBucketLifecycleConfigurationCommand,
  PutPublicAccessBlockCommand, S3ServiceException,
} from '@aws-sdk/client-s3';
import { adminClient, BUCKET } from './s3-admin.js';

const s3 = adminClient();

const LIFECYCLE = {
  Rules: [
    {
      ID: 'incoming-cleanup',
      Filter: { Prefix: '_incoming/' },
      Status: 'Enabled' as const,
      Expiration: { Days: 7 },
      NoncurrentVersionExpiration: { NoncurrentDays: 1 },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    },
    {
      ID: 'derived-noncurrent',
      Filter: { Prefix: 'derived/' },
      Status: 'Enabled' as const,
      NoncurrentVersionExpiration: { NoncurrentDays: 30 },
    },
  ],
};

async function main(): Promise<void> {
  // 建桶(Object Lock 必须建桶时启用,事后无法补)
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`bucket ${BUCKET} 已存在`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET, ObjectLockEnabledForBucket: true }));
    console.log(`bucket ${BUCKET} 已创建(object lock enabled)`);
  }

  // Public access block(幂等 PUT)
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: BUCKET,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true,
        IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    }),
  ).catch((e) => console.warn('public-access-block 不支持(MinIO 默认即私有):', shortMsg(e)));

  // SSE 桶默认加密
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: BUCKET,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } }],
      },
    }),
  ).catch((e) => console.warn('SSE 配置失败(开发环境 KMS 未配时降级,生产强制):', shortMsg(e)));

  // Lifecycle
  await s3.send(
    new PutBucketLifecycleConfigurationCommand({ Bucket: BUCKET, LifecycleConfiguration: LIFECYCLE }),
  );

  // ===== 自检(spec m0-04 §1 验证命令) =====
  const failures: string[] = [];

  const versioning = await s3.send(new GetBucketVersioningCommand({ Bucket: BUCKET }));
  if (versioning.Status !== 'Enabled') failures.push(`versioning != Enabled: ${versioning.Status}`);

  const lock = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: BUCKET }));
  if (lock.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled') failures.push('object lock 未启用');
  if (lock.ObjectLockConfiguration?.Rule) failures.push('存在桶级默认保留期 —— ADR-045 禁止');

  const lifecycle = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }));
  const ids = (lifecycle.Rules ?? []).map((r) => r.ID).sort();
  if (!ids.includes('incoming-cleanup') || !ids.includes('derived-noncurrent')) {
    failures.push(`lifecycle 规则缺失: ${ids.join(',')}`);
  }

  try {
    const enc = await s3.send(new GetBucketEncryptionCommand({ Bucket: BUCKET }));
    if (!enc.ServerSideEncryptionConfiguration) throw new Error('empty');
  } catch {
    const strict = process.env.NODE_ENV === 'production';
    const msg = 'SSE 未配置(开发环境降级通过,生产强制)';
    if (strict) failures.push(msg);
    else console.warn(msg);
  }

  try {
    const pab = await s3.send(new GetPublicAccessBlockCommand({ Bucket: BUCKET }));
    const c = pab.PublicAccessBlockConfiguration;
    if (!(c?.BlockPublicAcls && c.BlockPublicPolicy && c.IgnorePublicAcls && c.RestrictPublicBuckets)) {
      failures.push('public access block 不全');
    }
  } catch {
    console.warn('public-access-block 查询不支持(MinIO 默认私有,降级通过)');
  }

  if (failures.length) {
    console.error('自检失败:\n- ' + failures.join('\n- '));
    process.exit(1);
  }
  console.log('provision-bucket 自检通过');
}

const shortMsg = (e: unknown) => (e instanceof S3ServiceException ? e.name : String(e).slice(0, 80));
await main();
