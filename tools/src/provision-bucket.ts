// spec m0-04 §1:幂等建桶 + 自检。第二次运行无变更退出 0(99 A1)。
// ADR-048:后端能力不再假定。先探测,再按能力分流,最后**如实打印 WORM 姿态** ——
// 在没有服务端 WORM 的后端上"自检通过"若不加区分,就是把最重要的保证悄悄降级。
import {
  CreateBucketCommand, GetBucketCorsCommand, GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand, GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand, GetPublicAccessBlockCommand, HeadBucketCommand,
  PutBucketCorsCommand, PutBucketEncryptionCommand, PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand, PutPublicAccessBlockCommand, S3ServiceException,
} from '@aws-sdk/client-s3';
import { adminClient, BUCKET, ENDPOINT } from './s3-admin.js';

const s3 = adminClient();
const shortMsg = (e: unknown) => (e instanceof S3ServiceException ? e.name : String(e).slice(0, 80));
const isNotImplemented = (e: unknown) =>
  e instanceof S3ServiceException && (e.name === 'NotImplemented' || e.$metadata?.httpStatusCode === 501);

const LIFECYCLE = {
  Rules: [
    {
      ID: 'incoming-cleanup',
      Filter: { Prefix: '_incoming/' },
      Status: 'Enabled' as const,
      Expiration: { Days: 7 },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    },
    {
      ID: 'probe-cleanup',
      Filter: { Prefix: '_probe/' },
      Status: 'Enabled' as const,
      Expiration: { Days: 1 },
    },
  ],
};
/** 仅在支持版本化的后端上追加(R2 无版本化,带上这些字段会被整条拒绝) */
const LIFECYCLE_VERSIONED_EXTRA = {
  ID: 'derived-noncurrent',
  Filter: { Prefix: 'derived/' },
  Status: 'Enabled' as const,
  NoncurrentVersionExpiration: { NoncurrentDays: 30 },
};

// CORS(m1-02 §7.2 / m0-CHANGES #8):跨源 PUT 必触发 preflight,AllowedHeaders 漏一个就是整条直传链死。
// 头列表取**并集**:S3/MinIO 走 x-amz-checksum-sha256,R2 走 content-md5(ADR-048 后果 1)。
// 多放行几个请求头不构成风险,而少放一个要重新拿 admin 凭证 —— 不对称,故取并集。
const WEB_ORIGINS = (process.env.WEB_ORIGIN ?? 'http://localhost:5173')
  .split(',').map((o) => o.trim()).filter(Boolean);
const CORS_HEADERS = [
  'content-type', 'content-md5',
  'x-amz-checksum-sha256', 'x-amz-sdk-checksum-algorithm',
  'x-amz-content-sha256', 'x-amz-date', 'authorization',
];
const CORS_RULES = {
  CORSRules: [{
    AllowedOrigins: WEB_ORIGINS,
    AllowedMethods: ['PUT', 'GET', 'HEAD'],
    AllowedHeaders: CORS_HEADERS,
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 600,
  }],
};

interface Capabilities {
  versioning: boolean;
  objectLock: boolean;
  corsApi: boolean;
  lifecycleApi: boolean;
  sse: boolean;
  publicAccessBlock: boolean;
}

/** 探测而非假定(ADR-048)。判据是后端自己的响应码。 */
async function detect(): Promise<Capabilities> {
  const caps: Capabilities = {
    versioning: false, objectLock: false, corsApi: false,
    lifecycleApi: false, sse: false, publicAccessBlock: false,
  };
  try {
    const v = await s3.send(new GetBucketVersioningCommand({ Bucket: BUCKET }));
    caps.versioning = v.Status === 'Enabled';
    if (!caps.versioning) {
      await s3.send(new PutBucketVersioningCommand({
        Bucket: BUCKET, VersioningConfiguration: { Status: 'Enabled' },
      }));
      caps.versioning = (await s3.send(new GetBucketVersioningCommand({ Bucket: BUCKET }))).Status === 'Enabled';
    }
  } catch (e) {
    if (!isNotImplemented(e)) console.warn('versioning 探测异常:', shortMsg(e));
  }
  try {
    const l = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: BUCKET }));
    caps.objectLock = l.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled';
  } catch { /* 未启用或不支持 */ }
  return caps;
}

async function main(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`bucket ${BUCKET} 已存在`);
  } catch {
    // Object Lock 必须建桶时启用,事后无法补
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET, ObjectLockEnabledForBucket: true }))
      .catch(async (e) => {
        if (!isNotImplemented(e)) throw e;
        await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
      });
    console.log(`bucket ${BUCKET} 已创建`);
  }

  const caps = await detect();

  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: BUCKET,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, BlockPublicPolicy: true,
      IgnorePublicAcls: true, RestrictPublicBuckets: true,
    },
  })).then(() => { caps.publicAccessBlock = true; })
    .catch((e) => console.warn('public-access-block 不支持(MinIO/R2 默认即私有):', shortMsg(e)));

  await s3.send(new PutBucketEncryptionCommand({
    Bucket: BUCKET,
    ServerSideEncryptionConfiguration: {
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } }],
    },
  })).then(() => { caps.sse = true; })
    .catch((e) => console.warn('SSE 配置不支持或失败(R2 静态加密默认开启,不可配):', shortMsg(e)));

  const rules = caps.versioning ? [...LIFECYCLE.Rules, LIFECYCLE_VERSIONED_EXTRA] : LIFECYCLE.Rules;
  await s3.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: BUCKET, LifecycleConfiguration: { Rules: rules },
  })).then(() => { caps.lifecycleApi = true; })
    .catch((e) => console.warn('PutBucketLifecycleConfiguration 不支持:', shortMsg(e)));

  await s3.send(new PutBucketCorsCommand({ Bucket: BUCKET, CORSConfiguration: CORS_RULES }))
    .then(() => { caps.corsApi = true; })
    .catch((e) => console.warn('PutBucketCors 不支持(MinIO 由环境变量配置):', shortMsg(e)));

  // ===== 自检 =====
  const failures: string[] = [];

  if (caps.lifecycleApi) {
    const lifecycle = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }));
    const ids = (lifecycle.Rules ?? []).map((r) => r.ID).sort();
    if (!ids.includes('incoming-cleanup')) failures.push(`lifecycle 缺 incoming-cleanup: ${ids.join(',')}`);
  }
  if (caps.corsApi) {
    const got = await s3.send(new GetBucketCorsCommand({ Bucket: BUCKET }));
    if (!(got.CORSRules ?? []).length) failures.push('CORS 规则读回为空');
  }
  if (caps.objectLock) {
    const lock = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: BUCKET }));
    if (lock.ObjectLockConfiguration?.Rule) failures.push('存在桶级默认保留期 —— ADR-045 禁止(必须逐对象)');
  }
  if (!caps.sse && process.env.NODE_ENV === 'production' && !isR2()) {
    failures.push('SSE 未配置(生产强制)');
  }

  // CORS 自检:发真实 preflight,验证**行为**而非配置(m1/CHANGES #2)
  const origin = WEB_ORIGINS[0]!;
  try {
    const pre = await fetch(`${ENDPOINT}/${BUCKET}/_probe/cors-preflight`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type,content-md5',
      },
    });
    const allowOrigin = pre.headers.get('access-control-allow-origin');
    const allowHeaders = (pre.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    if (pre.status >= 400) failures.push(`CORS preflight 失败: HTTP ${pre.status}`);
    else if (!allowOrigin || (allowOrigin !== '*' && allowOrigin !== origin)) {
      failures.push(`CORS preflight allow-origin 不匹配: ${allowOrigin}`);
    } else if (!(allowHeaders.includes('content-md5') || allowHeaders.includes('*'))) {
      failures.push(`CORS preflight 未放行 content-md5: ${allowHeaders}`);
    }
  } catch (e) {
    failures.push(`CORS preflight 探测失败: ${shortMsg(e)}`);
  }

  // ===== WORM 姿态:如实播报,不许悄悄降级 =====
  console.log('\n── WORM 姿态(ADR-048)──');
  console.log(`  版本化        : ${caps.versioning ? '✓ 启用' : '✗ 后端不支持'}`);
  console.log(`  逐对象保留锁  : ${caps.objectLock ? '✓ 启用' : '✗ 后端不支持'}`);
  if (caps.versioning && caps.objectLock) {
    console.log('  ⇒ 服务端强制的 WORM 成立(docs/04 §1 权威矩阵可原样落地)');
  } else {
    console.log('  ⇒ **服务端不强制 WORM**。ADR-048 要求三条补偿全部到位,缺一不可:');
    console.log('     ① L1 一律 If-None-Match: * 仅创建写(应用不变式,验收须断言)');
    console.log('     ② 前缀级保留策略(R2 Bucket Locks —— 只能经 Cloudflare 控制面配置)');
    console.log('     ③ 异地冷备到支持 Object Lock 的存储或离线介质');
    console.log('     未全部落实之前,本桶不得承载生产 L1。');
  }

  if (failures.length) {
    console.error('\n自检失败:\n- ' + failures.join('\n- '));
    process.exit(1);
  }
  console.log('\nprovision-bucket 自检通过');
}

function isR2(): boolean {
  return ENDPOINT.includes('r2.cloudflarestorage.com');
}

await main();
