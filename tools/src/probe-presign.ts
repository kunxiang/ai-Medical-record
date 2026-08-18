// 预签名直传的变体探针:定位"哪一个签名头让 R2 拒绝"。
// 浏览器直传是 M1 上传链的地基(m1-04 §2),它不通则整条链要改设计,
// 所以必须精确到"是校验和头的问题,还是签名算法/路径风格的问题"。
import { createHash, randomUUID } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ENDPOINT = process.env.S3_ENDPOINT!;
const BUCKET = process.env.S3_BUCKET!;
const REGION = process.env.S3_REGION ?? 'auto';
const body = Buffer.from('presign-variant-probe\n', 'utf-8');
const shaB64 = createHash('sha256').update(body).digest('base64');

function client(forcePathStyle: boolean): S3Client {
  return new S3Client({
    endpoint: ENDPOINT, region: REGION, forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
  });
}

interface Variant {
  name: string;
  pathStyle: boolean;
  checksum: boolean;
  sendChecksumHeader: boolean;
  contentType: boolean;
}
const variants: Variant[] = [
  { name: 'path-style + 无校验和', pathStyle: true, checksum: false, sendChecksumHeader: false, contentType: true },
  { name: 'path-style + 签名含校验和 + 发头', pathStyle: true, checksum: true, sendChecksumHeader: true, contentType: true },
  { name: 'path-style + 签名含校验和 + 不发头', pathStyle: true, checksum: true, sendChecksumHeader: false, contentType: true },
  { name: 'path-style + 不签校验和 + 发头', pathStyle: true, checksum: false, sendChecksumHeader: true, contentType: true },
  { name: 'virtual-host + 无校验和', pathStyle: false, checksum: false, sendChecksumHeader: false, contentType: true },
  { name: 'virtual-host + 签名含校验和 + 发头', pathStyle: false, checksum: true, sendChecksumHeader: true, contentType: true },
  { name: 'path-style + 无校验和 + 无 content-type', pathStyle: true, checksum: false, sendChecksumHeader: false, contentType: false },
];

const ok: string[] = [];
for (const v of variants) {
  const key = `_probe/presign-${randomUUID().slice(0, 8)}.txt`;
  const c = client(v.pathStyle);
  try {
    const url = await getSignedUrl(c, new PutObjectCommand({
      Bucket: BUCKET, Key: key,
      ...(v.contentType ? { ContentType: 'text/plain' } : {}),
      ...(v.checksum ? { ChecksumSHA256: shaB64 } : {}),
    }), { expiresIn: 900 });
    const headers: Record<string, string> = {};
    if (v.contentType) headers['content-type'] = 'text/plain';
    if (v.sendChecksumHeader) headers['x-amz-checksum-sha256'] = shaB64;
    const res = await fetch(url, { method: 'PUT', headers, body });
    const txt = res.ok ? '' : (await res.text()).replace(/\s+/g, ' ').slice(0, 130);
    console.log(`${res.ok ? '✓' : '✗'} ${v.name} — HTTP ${res.status} ${txt}`);
    if (res.ok) {
      ok.push(v.name);
      await c.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
    }
  } catch (e) {
    console.log(`✗ ${v.name} — ${e instanceof Error ? e.message.slice(0, 130) : String(e)}`);
  }
  await c.destroy();
}
console.log(`\n可用变体 ${ok.length}/${variants.length}${ok.length ? ':\n- ' + ok.join('\n- ') : ''}`);
