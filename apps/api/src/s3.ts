import {
  CompleteMultipartUploadCommand, CopyObjectCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command,
  PutObjectCommand, S3Client, S3ServiceException, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, LOCK_RETENTION_YEARS, PROBE_RETENTION_MS } from './env.js';
import { buildKey } from '@amr/storage';

function s3Client(endpoint: string): S3Client {
  return new S3Client({
    // MinIO 对新版 SDK 默认附加的 CRC32 校验和头返回 501;显式的 ChecksumSHA256 仍会发送
    requestChecksumCalculation: 'WHEN_REQUIRED',
    endpoint,
    region: env.s3.region,
    forcePathStyle: true,
    credentials: { accessKeyId: env.s3.accessKeyId, secretAccessKey: env.s3.secretAccessKey },
  });
}

export const s3 = s3Client(env.s3.endpoint);

// 服务端对象操作走容器内 endpoint；交给浏览器/外部模型的 URL 必须从公开 endpoint
// 参与签名。签名后替换 host 会使 SigV4 的 host 签名失效，不能做字符串改写。
const publicS3 = env.s3.publicEndpoint === env.s3.endpoint
  ? s3
  : s3Client(env.s3.publicEndpoint);

const B = env.s3.bucket;

// ── 后端能力(ADR-048)──────────────────────────────────────────────────
// 不假定后端支持什么,启动时探测一次。R2 对 `x-amz-object-lock-mode` 返回 501 拒绝
// (**明确拒绝而非静默忽略** —— 这点很重要:不会出现"以为上了锁其实没上"的静默降级),
// 因此带锁参数的写入在 R2 上会每次硬失败。探测后按能力分流。
export interface BackendCapabilities {
  /** 逐对象保留锁(GOVERNANCE)。false ⇒ WORM 不由服务端强制,靠 ADR-048 的三条补偿 */
  objectLock: boolean;
}
let caps: BackendCapabilities = { objectLock: true };
export function backendCapabilities(): BackendCapabilities {
  return caps;
}

function retainUntil(): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() + LOCK_RETENTION_YEARS);
  return d;
}

/** 锁参数:后端不支持时返回空对象。
 *  **禁止**在此处静默降级而不播报 —— 姿态由 startupProbe 如实打印。 */
function lockParams(): { ObjectLockMode?: 'GOVERNANCE'; ObjectLockRetainUntilDate?: Date } {
  return caps.objectLock
    ? { ObjectLockMode: 'GOVERNANCE', ObjectLockRetainUntilDate: retainUntil() }
    : {};
}

const isStatus = (e: unknown, ...codes: number[]) =>
  e instanceof S3ServiceException && codes.includes(e.$metadata.httpStatusCode ?? 0);

/** WORM 对象:If-None-Match + GOVERNANCE 锁(spec m0-03 §5.1)。
 *  已存在 → 'exists'(调用方做幂等续跑判定)。 */
export async function putWorm(key: string, body: Buffer, contentType: string): Promise<'created' | 'exists'> {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: B, Key: key, Body: body, ContentType: contentType,
        IfNoneMatch: '*',
        ...lockParams(),
      }),
    );
    return 'created';
  } catch (e) {
    if (isStatus(e, 412, 409)) return 'exists';
    throw e;
  }
}

/** 重写式对象(_person.json / people.json):普通 PUT,不上锁。 */
export async function putRewritable(key: string, body: Buffer, contentType = 'application/json'): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: B, Key: key, Body: body, ContentType: contentType }));
}

export async function getObjectText(key: string): Promise<{ text: string; etag: string } | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: B, Key: key }));
    return { text: await r.Body!.transformToString('utf-8'), etag: r.ETag! };
  } catch (e) {
    if (isStatus(e, 404)) return null;
    throw e;
  }
}

export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: B, Prefix: prefix, ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    }));
    for (const item of result.Contents ?? []) if (item.Key) keys.push(item.Key);
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

/** 追加型 JSONL:读-改-写 + 条件写(If-Match/If-None-Match),412 重试 ≤3(spec m0-03 §5.4)。
 *  并发主锁是 pg advisory lock(调用方持有);这里是 S3 层防御。
 *  每个版本 GOVERNANCE 上锁(spec m0-04 §2)。 */
export async function appendJsonl(key: string, line: Buffer): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await getObjectText(key);
    const body = existing ? Buffer.concat([Buffer.from(existing.text, 'utf-8'), line]) : line;
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: B, Key: key, Body: body, ContentType: 'application/jsonl',
          ...(existing ? { IfMatch: existing.etag } : { IfNoneMatch: '*' }),
          ...lockParams(),
        }),
      );
      return;
    } catch (e) {
      if (isStatus(e, 412, 409) && attempt < 2) continue;
      throw e;
    }
  }
  throw new Error(`appendJsonl 条件写连续失败: ${key}`);
}

export interface HeadInfo {
  byteSize: number;
  contentType: string | undefined;
  checksumSha256Base64: string | undefined;
  etag: string;
}

export async function headObject(key: string): Promise<HeadInfo | null> {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: B, Key: key, ChecksumMode: 'ENABLED' }));
    return {
      byteSize: r.ContentLength ?? 0,
      contentType: r.ContentType,
      checksumSha256Base64: r.ChecksumSHA256,
      etag: r.ETag!,
    };
  } catch (e) {
    if (isStatus(e, 404)) return null;
    throw e;
  }
}

/** Head-then-Copy(审核 #001 #2):CopyObject 无目标端条件写,先 Head 判存在。
 *  竞态由 DB 幂等键 + storage_key UNIQUE 兜底。 */
export async function copyWithLock(fromKey: string, toKey: string, contentType: string): Promise<void> {
  await s3.send(
    new CopyObjectCommand({
      Bucket: B, Key: toKey,
      CopySource: `${B}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`,
      MetadataDirective: 'REPLACE',
      ContentType: contentType,
      ...lockParams(),
    }),
  );
}

export async function deleteObjectIfPossible(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: B, Key: key }));
  } catch {
    // 删除失败仅记日志(lifecycle 兜底,spec m0-06 §2.③.7)
  }
}

/** 删除可重算的 L2 前缀。与临时上传清理不同，这里失败必须上抛：
 * 页面重排后继续命中旧 preview 会静默展示错误内容。DeleteObject 本身幂等。 */
export async function deletePrefix(prefix: string): Promise<number> {
  const keys = await listKeys(prefix);
  for (const key of keys) {
    await s3.send(new DeleteObjectCommand({ Bucket: B, Key: key }));
  }
  return keys.length;
}

/** L2 派生物:普通 PUT,**严禁上锁**(04 §1 权威矩阵)。 */
export async function putDerivative(key: string, body: Buffer): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: B, Key: key, Body: body, ContentType: 'image/webp' }));
}

export async function getObjectBytes(key: string): Promise<Buffer | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: B, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  } catch (e) {
    if (isStatus(e, 404)) return null;
    throw e;
  }
}

export async function presignGetKey(key: string, expiresIn = 300): Promise<string> {
  return getSignedUrl(publicS3, new GetObjectCommand({ Bucket: B, Key: key }), { expiresIn });
}

export async function presignPut(key: string, contentType: string, sha256Base64: string): Promise<{ url: string; headers: Record<string, string> }> {
  const cmd = new PutObjectCommand({
    Bucket: B, Key: key, ContentType: contentType, ChecksumSHA256: sha256Base64,
  });
  const url = await getSignedUrl(publicS3, cmd, {
    expiresIn: 900,
    unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
  });
  return { url, headers: { 'Content-Type': contentType, 'x-amz-checksum-sha256': sha256Base64 } };
}

export async function createMultipartUpload(key: string, contentType: string): Promise<string> {
  const result = await s3.send(new CreateMultipartUploadCommand({
    Bucket: B, Key: key, ContentType: contentType,
  }));
  if (!result.UploadId) throw new Error('S3 未返回 multipart UploadId');
  return result.UploadId;
}

export async function presignMultipartPart(
  key: string,
  uploadId: string,
  partNumber: number,
): Promise<string> {
  return getSignedUrl(publicS3, new UploadPartCommand({
    Bucket: B, Key: key, UploadId: uploadId, PartNumber: partNumber,
  }), { expiresIn: 900 });
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
): Promise<void> {
  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: B, Key: key, UploadId: uploadId,
    MultipartUpload: {
      Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
    },
  }));
}

export async function presignGet(key: string): Promise<string> {
  return getSignedUrl(publicS3, new GetObjectCommand({ Bucket: B, Key: key }), { expiresIn: 300 });
}

/** 启动探针(spec m0-04 §3):任一断言失败 → 抛错拒绝启动。 */
export async function startupProbe(): Promise<void> {
  // 实例唯一后缀:多实例并发启动时探针互不干扰(specs/m0/CHANGES.md #2)
  const suffix = Math.random().toString(36).slice(2, 10);
  const key = buildKey.probe('startup', suffix);
  const body1 = Buffer.from('probe-1\n');
  const body2 = Buffer.from('probe-2\n');

  // 清场(探针对象不上锁,可删)
  await deleteObjectIfPossible(key);

  // 1. If-None-Match:首次成功,重复 412
  await s3.send(new PutObjectCommand({ Bucket: B, Key: key, Body: body1, IfNoneMatch: '*' }));
  let dup = false;
  try {
    await s3.send(new PutObjectCommand({ Bucket: B, Key: key, Body: body2, IfNoneMatch: '*' }));
  } catch (e) {
    dup = isStatus(e, 412, 409);
  }
  if (!dup) throw new Error('探针失败:If-None-Match 未被强制(条件写不支持)');

  // 2. If-Match:匹配成功;错 etag 412
  const head = await headObject(key);
  await s3.send(new PutObjectCommand({ Bucket: B, Key: key, Body: body2, IfMatch: head!.etag }));
  let stale = false;
  try {
    await s3.send(new PutObjectCommand({ Bucket: B, Key: key, Body: body1, IfMatch: head!.etag }));
  } catch (e) {
    stale = isStatus(e, 412, 409);
  }
  if (!stale) throw new Error('探针失败:If-Match 未被强制');

  // 3. 错误校验和被拒
  let badChecksum = false;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: B, Key: key, Body: body1,
      ChecksumSHA256: Buffer.alloc(32, 1).toString('base64'),
    }));
  } catch {
    badChecksum = true;
  }
  if (!badChecksum) throw new Error('探针失败:错误 sha256 校验和未被拒绝');

  // 4+5. 逐对象保留锁。**这一段是能力探测,不是硬性要求**(ADR-048):
  //      不支持时按补偿措施运行并如实播报姿态,而不是拒绝启动 ——
  //      但也绝不静默降级,姿态每次启动都打印。
  const lockKey = buildKey.probe('lock-probe', suffix);
  const until = new Date(Date.now() + PROBE_RETENTION_MS);
  let lockSupported = false;
  try {
    await s3.send(new CopyObjectCommand({
      Bucket: B, Key: lockKey, CopySource: `${B}/${key}`,
      MetadataDirective: 'REPLACE',
      ObjectLockMode: 'GOVERNANCE', ObjectLockRetainUntilDate: until,
    }));
    const lockHead = await s3.send(new HeadObjectCommand({ Bucket: B, Key: lockKey }));
    if (lockHead.ObjectLockMode !== 'GOVERNANCE') {
      throw new Error('CopyObject 未能附加 GOVERNANCE 锁(参数被静默忽略)');
    }
    // 无特权删除被锁版本 → 必须被拒。锁"配上了但拦不住"比不支持更危险。
    let lockEnforced = false;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: B, Key: lockKey, VersionId: lockHead.VersionId! }));
    } catch {
      lockEnforced = true;
    }
    if (!lockEnforced) throw new Error('GOVERNANCE 锁未拦截无特权版本删除');
    lockSupported = true;
  } catch (e) {
    if (isStatus(e, 501) || (e instanceof S3ServiceException && e.name === 'NotImplemented')) {
      lockSupported = false;   // 后端明确不支持(R2)
    } else {
      // 支持但行为不对 —— 这是缺陷,不是能力差异,必须拒绝启动
      throw new Error(`探针失败:逐对象锁行为异常 —— ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  caps = { objectLock: lockSupported };

  // ── WORM 姿态:如实播报,不许悄悄降级(ADR-048)──
  if (lockSupported) {
    console.log('[s3] WORM 姿态:✓ 逐对象保留锁由服务端强制');
  } else {
    console.warn(
      '[s3] WORM 姿态:✗ **服务端不强制 WORM**(后端不支持逐对象保留锁)。\n' +
      '     ADR-048 要求三条补偿全部到位,缺一不可:\n' +
      '       ① L1 一律 If-None-Match: * 仅创建写 —— 已由 putWorm 强制,且本探针刚验证过条件写生效\n' +
      '       ② 前缀级保留策略(R2 Bucket Locks,只能经 Cloudflare 控制面配置)\n' +
      '       ③ 异地冷备到支持 Object Lock 的存储或离线介质\n' +
      '     ②③ 未落实之前,本桶不得承载生产 L1。',
    );
  }
}
