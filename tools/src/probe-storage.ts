// 存储后端能力探针。回答一个问题:某个 S3 兼容实现能不能承载 L1(docs/04 权威矩阵)。
//
// 为什么要有这个脚本:L1 的保证不是"我们把对象放上去了",而是若干具体的服务端语义
// —— 版本化、逐对象保留(治理模式)、条件写、sha256 校验和。这些能力缺一项,
// docs/04 §1 里对应的那一行就落不了地。换后端时必须先跑它,而不是先跑迁移。
//
// 用法(凭证只经环境变量传入,禁止写进仓库):
//   S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY=... S3_SECRET_KEY=... \
//     npx tsx src/probe-storage.ts
import { createHash, randomUUID } from 'node:crypto';
import {
  CopyObjectCommand, CreateMultipartUploadCommand, AbortMultipartUploadCommand,
  DeleteObjectCommand, GetBucketCorsCommand, GetBucketVersioningCommand,
  GetObjectCommand, GetObjectLockConfigurationCommand, HeadBucketCommand, HeadObjectCommand,
  ListObjectVersionsCommand, ListObjectsV2Command, PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand, PutBucketVersioningCommand,
  PutObjectCommand, PutObjectRetentionCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ENDPOINT = process.env.S3_ENDPOINT;
const BUCKET = process.env.S3_BUCKET;
if (!ENDPOINT || !BUCKET) {
  console.error('需要 S3_ENDPOINT 与 S3_BUCKET(以及 S3_ACCESS_KEY / S3_SECRET_KEY)');
  process.exit(2);
}
const REGION = process.env.S3_REGION ?? 'auto';

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
});

const PREFIX = `_probe/capability-${randomUUID().slice(0, 8)}/`;
const cleanup: Array<{ Key: string; VersionId?: string }> = [];

type Verdict = 'YES' | 'NO' | 'PARTIAL';
const rows: Array<{ cap: string; verdict: Verdict; detail: string; impact: string }> = [];
function record(cap: string, verdict: Verdict, detail: string, impact: string): void {
  rows.push({ cap, verdict, detail: detail.slice(0, 220), impact });
  const mark = verdict === 'YES' ? '✓' : verdict === 'PARTIAL' ? '~' : '✗';
  console.log(`  ${mark} ${cap}${verdict === 'YES' ? '' : ` — ${detail.slice(0, 160)}`}`);
}
const errText = (e: unknown): string => {
  const a = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number }; message?: string };
  return `${a?.name ?? a?.Code ?? 'Error'}${a?.$metadata?.httpStatusCode ? ` ${a.$metadata.httpStatusCode}` : ''}: ${a?.message ?? ''}`;
};

const body = Buffer.from('amr-capability-probe\n', 'utf-8');
const bodySha256B64 = createHash('sha256').update(body).digest('base64');

// ── 0. 可达性与凭证 ──
console.log('0 可达性');
try {
  await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  record('桶可达且凭证有效', 'YES', '', '');
} catch (e) {
  record('桶可达且凭证有效', 'NO', errText(e), '一切免谈');
  console.log('\n无法继续:桶不可达。');
  process.exit(1);
}

// ── 1. 基本对象读写 + sha256 校验和 ──
console.log('1 对象读写与校验和');
const k1 = `${PREFIX}basic.txt`;
try {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: k1, Body: body, ContentType: 'text/plain',
    ChecksumSHA256: bodySha256B64,
  }));
  cleanup.push({ Key: k1 });
  record('PutObject 携带 ChecksumSHA256', 'YES', '', '');
} catch (e) {
  record('PutObject 携带 ChecksumSHA256', 'NO', errText(e),
    '上传链的"服务端独立校验字节"(m0-06 §2.③)失效,只能退回信任客户端申报的 sha256');
}
try {
  const h = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: k1, ChecksumMode: 'ENABLED' }));
  const ok = h.ChecksumSHA256 === bodySha256B64;
  record('HeadObject 读回 ChecksumSHA256', ok ? 'YES' : 'PARTIAL',
    `读回 ${h.ChecksumSHA256 ?? '(无)'} 期望 ${bodySha256B64}`,
    ok ? '' : '登记前的 Head 校验拿不到服务端校验和');
} catch (e) {
  record('HeadObject 读回 ChecksumSHA256', 'NO', errText(e), '同上');
}

// ── 2. 条件写(append-only JSONL 的并发防御,m0-03 §5.4)──
console.log('2 条件写');
const k2 = `${PREFIX}conditional.jsonl`;
let etag1: string | undefined;
try {
  const r = await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: k2, Body: body, ContentType: 'application/jsonl', IfNoneMatch: '*',
  }));
  etag1 = r.ETag;
  cleanup.push({ Key: k2 });
  record('If-None-Match: * 首建成功', 'YES', '', '');
} catch (e) {
  record('If-None-Match: * 首建成功', 'NO', errText(e), 'journal/manifest 的"仅创建"语义落不了地');
}
try {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: k2, Body: body, ContentType: 'application/jsonl', IfNoneMatch: '*',
  }));
  record('If-None-Match: * 重复创建被拒(412)', 'NO', '第二次创建竟然成功 —— 条件被忽略',
    '★ 危险:条件写被静默忽略比不支持更糟 —— 并发追加会互相覆盖且无人察觉');
} catch (e) {
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  record('If-None-Match: * 重复创建被拒(412)', status === 412 ? 'YES' : 'PARTIAL', errText(e),
    status === 412 ? '' : '拒了但不是 412,错误分类需适配');
}
try {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: k2, Body: Buffer.concat([body, body]),
    ContentType: 'application/jsonl', IfMatch: etag1,
  }));
  record('If-Match: <etag> 追加成功', 'YES', '', '');
} catch (e) {
  record('If-Match: <etag> 追加成功', 'NO', errText(e), 'JSONL 追加的 CAS 语义落不了地');
}
try {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: k2, Body: body, ContentType: 'application/jsonl', IfMatch: etag1,
  }));
  record('If-Match 陈旧 etag 被拒(412)', 'NO', '陈旧 etag 竟然写成功 —— 条件被忽略',
    '★ 危险:并发追加会丢行(m0-99 B5 的场景)');
} catch (e) {
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  record('If-Match 陈旧 etag 被拒(412)', status === 412 ? 'YES' : 'PARTIAL', errText(e), '');
}

// ── 3. 版本化(A7 WORM 真实语义 / A17 零字节变动取证的前提)──
console.log('3 版本化');
let versioningOn = false;
try {
  const v = await s3.send(new GetBucketVersioningCommand({ Bucket: BUCKET }));
  versioningOn = v.Status === 'Enabled';
  record('GetBucketVersioning', 'YES', `Status=${v.Status ?? '(未设置)'}`, '');
} catch (e) {
  record('GetBucketVersioning', 'NO', errText(e), '无法确认版本化状态');
}
if (!versioningOn) {
  try {
    await s3.send(new PutBucketVersioningCommand({
      Bucket: BUCKET, VersioningConfiguration: { Status: 'Enabled' },
    }));
    const v = await s3.send(new GetBucketVersioningCommand({ Bucket: BUCKET }));
    versioningOn = v.Status === 'Enabled';
    record('PutBucketVersioning 开启版本化', versioningOn ? 'YES' : 'PARTIAL',
      `设置后读回 Status=${v.Status ?? '(未设置)'}`, versioningOn ? '' : '设置未生效');
  } catch (e) {
    record('PutBucketVersioning 开启版本化', 'NO', errText(e),
      '★ 无版本化 ⇒ 覆盖即永久丢失;docs/04 的"裸 PUT 出新版本、原版本可恢复"不成立');
  }
}
try {
  const lv = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: PREFIX }));
  const n = (lv.Versions ?? []).length;
  record('ListObjectVersions', n > 0 ? 'YES' : 'PARTIAL', `返回 ${n} 个版本`,
    n > 0 ? '' : '返回空 —— A17 的 (Key,VersionId,ETag) 取证手段失效');
} catch (e) {
  record('ListObjectVersions', 'NO', errText(e), '★ A17"L1 零字节变动"的取证手段失效,需另找等价物');
}

// ── 4. 对象锁(治理模式逐对象保留,docs/04 §1 的 object-lock 列)──
console.log('4 对象锁');
try {
  const lc = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: BUCKET }));
  record('GetObjectLockConfiguration', 'YES', JSON.stringify(lc.ObjectLockConfiguration ?? {}), '');
} catch (e) {
  record('GetObjectLockConfiguration', 'NO', errText(e), '桶未启用对象锁(或不支持该 API)');
}
try {
  await s3.send(new PutObjectRetentionCommand({
    Bucket: BUCKET, Key: k1,
    Retention: { Mode: 'GOVERNANCE', RetainUntilDate: new Date(Date.now() + 3600_000) },
  }));
  record('PutObjectRetention(GOVERNANCE 逐对象)', 'YES', '', '');
} catch (e) {
  record('PutObjectRetention(GOVERNANCE 逐对象)', 'NO', errText(e),
    '★ docs/04 的 WORM 保证(原件/capture.json/journal 不可删改)失去服务端强制,退化为"靠权限约束"');
}

// ── 5. CopyObject(Head-then-Copy 搬运链)──
console.log('5 搬运与分片');
const k3 = `${PREFIX}copied.txt`;
try {
  await s3.send(new CopyObjectCommand({
    Bucket: BUCKET, Key: k3, CopySource: `/${BUCKET}/${encodeURIComponent(k1)}`,
  }));
  cleanup.push({ Key: k3 });
  record('CopyObject(_incoming → 最终 key)', 'YES', '', '');
} catch (e) {
  record('CopyObject(_incoming → 最终 key)', 'NO', errText(e), '★ 登记链的搬运步骤落不了地');
}
try {
  const mp = await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: `${PREFIX}mp.bin` }));
  await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: `${PREFIX}mp.bin`, UploadId: mp.UploadId! }));
  record('Multipart 分片上传(D14 续传的前提)', 'YES', '', '');
} catch (e) {
  record('Multipart 分片上传(D14 续传的前提)', 'NO', errText(e), 'D14 断点续传需另寻方案');
}

// ── 6. 预签名(浏览器直传)──
console.log('6 预签名与 CORS');
try {
  const url = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: BUCKET, Key: `${PREFIX}presigned.txt`, ContentType: 'text/plain', ChecksumSHA256: bodySha256B64,
  }), { expiresIn: 900 });
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain', 'x-amz-checksum-sha256': bodySha256B64 },
    body,
  });
  if (res.ok) cleanup.push({ Key: `${PREFIX}presigned.txt` });
  record('预签名 PUT(含 sha256 校验和头)', res.ok ? 'YES' : 'NO',
    `HTTP ${res.status} ${(await res.text()).slice(0, 160)}`,
    res.ok ? '' : '★ 浏览器直传落不了地');
} catch (e) {
  record('预签名 PUT(含 sha256 校验和头)', 'NO', errText(e), '★ 浏览器直传落不了地');
}
try {
  await s3.send(new PutBucketCorsCommand({
    Bucket: BUCKET,
    CORSConfiguration: {
      CORSRules: [{
        AllowedMethods: ['PUT', 'GET', 'HEAD'],
        AllowedOrigins: [process.env.WEB_ORIGIN ?? 'http://localhost:5173'],
        AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600,
      }],
    },
  }));
  const got = await s3.send(new GetBucketCorsCommand({ Bucket: BUCKET }));
  record('PutBucketCors / GetBucketCors', 'YES', `${(got.CORSRules ?? []).length} 条规则`, '');
} catch (e) {
  record('PutBucketCors / GetBucketCors', 'NO', errText(e), 'CORS 需改由控制台/其他通道配置(参照 MinIO 的处置)');
}

// ── 7. 生命周期(_incoming 清理)──
try {
  await s3.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: BUCKET,
    LifecycleConfiguration: {
      Rules: [{
        ID: 'amr-probe-incoming', Status: 'Enabled',
        Filter: { Prefix: '_probe/' }, Expiration: { Days: 1 },
      }],
    },
  }));
  record('PutBucketLifecycleConfiguration', 'YES', '', '');
} catch (e) {
  record('PutBucketLifecycleConfiguration', 'NO', errText(e), '_incoming 残留需应用层定期清理');
}

// ── 清理 ──
console.log('\n清理探针对象');
for (const o of cleanup) {
  try { await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.Key })); } catch { /* 被锁则留待过期 */ }
}
const left = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX })).catch(() => null);
console.log(`  剩余 ${(left?.Contents ?? []).length} 个探针对象(被保留锁住的属预期)`);

// ── 汇总 ──
console.log('\n═══ 能力矩阵 ═══');
for (const r of rows) {
  console.log(`${r.verdict.padEnd(7)} | ${r.cap}${r.detail ? ` | ${r.detail}` : ''}`);
}
const blockers = rows.filter((r) => r.verdict !== 'YES' && r.impact.startsWith('★'));
if (blockers.length) {
  console.log('\n═══ 阻断项(需 ADR 决策)═══');
  for (const b of blockers) console.log(`- ${b.cap}\n    ${b.impact}`);
}
console.log(`\n合计 ${rows.filter((r) => r.verdict === 'YES').length}/${rows.length} 项支持`);
await s3.destroy();
