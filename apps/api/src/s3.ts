import {
  CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand,
  PutObjectCommand, S3Client, S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, LOCK_RETENTION_YEARS, PROBE_RETENTION_MS } from './env.js';
import { buildKey } from '@amr/storage';

export const s3 = new S3Client({
  endpoint: env.s3.endpoint,
  region: env.s3.region,
  forcePathStyle: true,
  credentials: { accessKeyId: env.s3.accessKeyId, secretAccessKey: env.s3.secretAccessKey },
});

const B = env.s3.bucket;

function retainUntil(): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() + LOCK_RETENTION_YEARS);
  return d;
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
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: retainUntil(),
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
          ObjectLockMode: 'GOVERNANCE',
          ObjectLockRetainUntilDate: retainUntil(),
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
      ObjectLockMode: 'GOVERNANCE',
      ObjectLockRetainUntilDate: retainUntil(),
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
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: B, Key: key }), { expiresIn });
}

export async function presignPut(key: string, contentType: string, sha256Base64: string): Promise<{ url: string; headers: Record<string, string> }> {
  const cmd = new PutObjectCommand({
    Bucket: B, Key: key, ContentType: contentType, ChecksumSHA256: sha256Base64,
  });
  const url = await getSignedUrl(s3, cmd, {
    expiresIn: 900,
    unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
  });
  return { url, headers: { 'Content-Type': contentType, 'x-amz-checksum-sha256': sha256Base64 } };
}

export async function presignGet(key: string): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: B, Key: key }), { expiresIn: 300 });
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

  // 4. CopyObject 附锁参数 → 回读 GOVERNANCE(lock-probe,最短保留,留置)
  const lockKey = buildKey.probe('lock-probe', suffix);
  const until = new Date(Date.now() + PROBE_RETENTION_MS);
  await s3.send(new CopyObjectCommand({
    Bucket: B, Key: lockKey, CopySource: `${B}/${key}`,
    MetadataDirective: 'REPLACE',
    ObjectLockMode: 'GOVERNANCE', ObjectLockRetainUntilDate: until,
  }));
  const lockHead = await s3.send(new HeadObjectCommand({ Bucket: B, Key: lockKey }));
  if (lockHead.ObjectLockMode !== 'GOVERNANCE') {
    throw new Error('探针失败:CopyObject 未能附加 GOVERNANCE 锁');
  }

  // 5. 无特权删除被锁版本 → 应被拒
  let lockEnforced = false;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: B, Key: lockKey, VersionId: lockHead.VersionId! }));
  } catch {
    lockEnforced = true;
  }
  if (!lockEnforced) throw new Error('探针失败:GOVERNANCE 锁未拦截无特权版本删除');
}
