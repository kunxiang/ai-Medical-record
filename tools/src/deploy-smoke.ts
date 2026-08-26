// 部署冒烟:对**真实后端**(R2 / 生产 Postgres)跑通最小可用链路。
// 与 m0/m1 验收不同 —— 那两个验的是"实现对不对",这个验的是"这套部署起不起得来"。
//
// 用法(凭证只经环境变量,禁止写进仓库):
//   DATABASE_URL=... S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY=... S3_SECRET_KEY=... \
//   AUTH_SECRET=... API_URL=http://localhost:8300 npx tsx src/deploy-smoke.ts
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { adminClient, BUCKET } from './s3-admin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = process.env.API_URL ?? 'http://localhost:8300';
const EMAIL = process.env.SEED_EMAIL ?? 'owner@local.test';
const PASSWORD = process.env.SEED_PASSWORD ?? 'm0-acceptance-password';

let passed = 0;
const failed: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed.push(name); console.error(`  ✗ ${name} ${detail}`); }
};

async function api(method: string, p: string, token: string | null, body?: unknown) {
  const r = await fetch(API + p, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
}

console.log(`部署冒烟 · API=${API} · bucket=${BUCKET} · endpoint=${process.env.S3_ENDPOINT}`);

// ── 1. 服务可达与鉴权 ──
console.log('1 服务与鉴权');
const bad = await api('POST', '/api/v1/auth/login', null, { email: EMAIL, password: 'wrong-password' });
check('错误口令被拒(401)', bad.status === 401, `status=${bad.status}`);
const login = await api('POST', '/api/v1/auth/login', null, { email: EMAIL, password: PASSWORD });
check('登录成功', login.status === 200 && typeof login.json?.access_token === 'string', `status=${login.status}`);
const token: string = login.json?.access_token;
if (!token) { console.error('无法登录,后续全部跳过'); process.exit(1); }

// ── 2. 建档(写 L1:_person.json + journal)──
console.log('2 建档');
const personRes = await api('POST', '/api/v1/people', token, {
  display_name: `冒烟-${randomUUID().slice(0, 6)}`,
  birth_date: '2020-01-01', sex_at_birth: 'male', relation_to_owner: 'child',
});
check('建档 201', personRes.status === 201, `status=${personRes.status} ${personRes.text.slice(0, 200)}`);
const personId: string = personRes.json?.id;
const personSlug: string = personRes.json?.slug;

// ── 3. 上传链:presign → 直传 → 登记 ──
console.log('3 上传链(真实后端直传)');
const fixture = path.join(ROOT, 'fixtures/m1/photo-gps-o6.jpg');
let bytes: Buffer;
try { bytes = readFileSync(fixture); }
catch { console.error(`缺 fixture ${fixture};先跑 pnpm --filter @amr/tools gen-m1-fixtures`); process.exit(1); }
const sha256 = createHash('sha256').update(bytes).digest('hex');

const pre = await api('POST', '/api/v1/uploads/presign', token, {
  person_id: personId,
  files: [{ filename: 'photo-gps-o6.jpg', mime_type: 'image/jpeg', byte_size: bytes.length, sha256 }],
});
check('presign 200', pre.status === 200, `status=${pre.status} ${pre.text.slice(0, 200)}`);
const up = pre.json?.uploads?.[0];

if (up) {
  if (process.env.S3_PUBLIC_ENDPOINT) {
    check(
      '预签名 URL 使用公网 endpoint',
      new URL(up.url).origin === new URL(process.env.S3_PUBLIC_ENDPOINT).origin,
      `actual=${new URL(up.url).origin}`,
    );
  }
  const put = await fetch(up.url, { method: 'PUT', headers: up.headers, body: bytes });
  check('浏览器直传路径可用(预签名 PUT)', put.ok, `HTTP ${put.status} ${(await put.text()).slice(0, 160)}`);

  const clientDocId = randomUUID();
  const reg = await api('POST', '/api/v1/documents', token, {
    person_id: personId, person_confirmed: true, confirmed_by: 'capture_ui',
    batch_id: pre.json.batch_id, source: 'camera',
    captured_at: new Date().toISOString(),
    pages: [{ upload_id: up.upload_id, page_no: 1, capture_order: 1, width: 1200, height: 800, sha256, exif: null }],
    client_document_id: clientDocId,
  });
  check('登记 201', reg.status === 201, `status=${reg.status} ${reg.text.slice(0, 300)}`);

  // 幂等重放:审核 #002 A-1 的回归 —— 重试必然重新 presign,不得 409
  const pre2 = await api('POST', '/api/v1/uploads/presign', token, {
    person_id: personId,
    files: [{ filename: 'photo-gps-o6.jpg', mime_type: 'image/jpeg', byte_size: bytes.length, sha256 }],
  });
  const up2 = pre2.json?.uploads?.[0];
  await fetch(up2.url, { method: 'PUT', headers: up2.headers, body: bytes });
  const replay = await api('POST', '/api/v1/documents', token, {
    person_id: personId, person_confirmed: true, confirmed_by: 'capture_ui',
    batch_id: pre2.json.batch_id, source: 'camera',
    captured_at: reg.json?.captured_at,
    pages: [{ upload_id: up2.upload_id, page_no: 1, capture_order: 1, width: 1200, height: 800, sha256, exif: null }],
    client_document_id: clientDocId,
  });
  check('幂等重放 200(而非 409)', replay.status === 200, `status=${replay.status} code=${replay.json?.error?.code}`);

  const docId: string = reg.json?.id;
  const shortId: string = reg.json?.short_id;

  // ── 4. L1 落桶且字节零改动 ──
  console.log('4 L1 落桶');
  const admin = adminClient();
  const listed = await admin.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `people/${personSlug}/` }));
  const keys = (listed.Contents ?? []).map((o) => o.Key!);
  check('原件已落桶', keys.some((k) => k.endsWith('page-01.jpg')), keys.join(',').slice(0, 200));
  check('capture.json 已落桶', keys.some((k) => k.endsWith('capture.json')));
  check('page-01.json 已落桶', keys.some((k) => k.endsWith('page-01.json')));

  // 原件字节零改动:与上传的 fixture 逐字节比对(不是"与我们自己算的值比",那是同义反复)
  const originKey = keys.find((k) => k.endsWith('page-01.jpg'));
  if (originKey) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const obj = await admin.send(new GetObjectCommand({ Bucket: BUCKET, Key: originKey }));
    const stored = Buffer.from(await obj.Body!.transformToByteArray());
    check('原件 sha256 == 上传前的已知值(字节零改动)',
      createHash('sha256').update(stored).digest('hex') === sha256);
  }

  // ── 5. 派生物(L2)与 AI 输入变体 ──
  console.log('5 派生物');
  const thumb = await fetch(`${API}/api/v1/documents/${docId}/pages/1/thumb?access_token=${token}`, { redirect: 'manual' });
  check('缩略图端点可用(302)', thumb.status === 302, `status=${thumb.status}`);
  const derived = await admin.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `derived/${personSlug}/${shortId}/` }));
  check('派生物已落 derived/', (derived.Contents ?? []).length > 0);

  // ── 6. 浏览 ──
  console.log('6 浏览');
  const list = await api('GET', `/api/v1/documents?person_id=${personId}&limit=10`, token);
  check('列表可用且含该文档', list.status === 200 && list.json?.documents?.some((d: any) => d.id === docId),
    `status=${list.status}`);

  // ── 7. AI 作业已投递(与登记同事务)──
  console.log('7 AI 作业');
  const ai = await api('GET', `/api/v1/documents/${docId}/ai`, token);
  check('AI 状态端点可用', ai.status === 200, `status=${ai.status}`);
  check('登记时已投递 stage1 作业', (ai.json?.jobs ?? []).some((j: any) => j.kind === 'stage1'),
    JSON.stringify(ai.json?.jobs));
  check('AI 状态不返回 full_text', !JSON.stringify(ai.json ?? {}).includes('full_text'));
}

console.log(`\n通过 ${passed} 项;失败 ${failed.length} 项`);
if (failed.length) { console.error('失败清单:\n- ' + failed.join('\n- ')); process.exit(1); }
console.log('部署冒烟通过 —— 这套部署可以进行部署测试');
