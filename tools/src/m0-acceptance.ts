// spec m0-99:A 组端到端验收。前置:docker compose 已起、迁移已跑、provision/gen-meta/seed 已完成、
// API 已以 M0_TEST_HOOKS=1 启动(见 tools/src/m0-run.sh 编排)。
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand,
  PutObjectCommand, S3ServiceException,
} from '@aws-sdk/client-s3';
import { parseKey } from '@amr/storage';
import { adminClient, appClient, BUCKET } from './s3-admin.js';

const API = process.env.API_URL ?? 'http://localhost:8300';
const API2 = process.env.API2_URL ?? 'http://localhost:8301';
const EMAIL = process.env.SEED_EMAIL ?? 'owner@local.test';
const PASSWORD = process.env.SEED_PASSWORD ?? 'm0-acceptance-password';
const admin = adminClient();
const app = appClient();

let passed = 0;
const failed: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed.push(name);
    console.error(`  ✗ ${name} ${detail}`);
  }
}
const sha256hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function api(
  method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any; text: string }> {
  const r = await fetch(API + path, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* noop */ }
  return { status: r.status, json, text };
}

async function listAll(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const r = await admin.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}
const getText = async (key: string) => {
  const r = await admin.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return r.Body!.transformToString('utf-8');
};

// 生成一个最小合法 JPEG(SOI + APP0 + EOI 骨架 + 随机负载,MIME 语义上够用)
function fakeJpeg(seedByte: number): Buffer {
  const payload = Buffer.alloc(4096, seedByte);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), payload, Buffer.from([0xff, 0xd9])]);
}

async function uploadOneDocument(token: string, personId: string, clientDocId: string, seed = 7) {
  const img = fakeJpeg(seed);
  const presign = await api('POST', '/api/v1/uploads/presign', {
    token,
    body: { person_id: personId, files: [{ filename: 'IMG_0001.jpg', mime_type: 'image/jpeg', byte_size: img.length, sha256: sha256hex(img) }] },
  });
  if (presign.status !== 200) throw new Error(`presign 失败: ${presign.text}`);
  const up = presign.json.uploads[0];
  const put = await fetch(up.url, { method: 'PUT', headers: up.headers, body: img });
  if (put.status !== 200) throw new Error(`直传失败: ${put.status} ${await put.text()}`);
  const doc = await api('POST', '/api/v1/documents', {
    token,
    body: {
      person_id: personId, person_confirmed: true, batch_id: presign.json.batch_id,
      source: 'camera', captured_at: '2026-08-17T10:32:11+08:00',
      pages: [{ upload_id: up.upload_id, page_no: 1, width: 3024, height: 4032, sha256: sha256hex(img) }],
      client_document_id: clientDocId,
    },
  });
  return { presign: presign.json, doc, img };
}

// ══════════════ A1 / A2 ══════════════
console.log('A1 provision 幂等 + 桶配置');
execSync('pnpm --silent run provision-bucket', { stdio: 'pipe' });
const second = execSync('pnpm --silent run provision-bucket', { encoding: 'utf-8' });
check('A1 第二次 provision 自检通过退出 0', second.includes('自检通过'));

console.log('A2 _meta');
const metaKeys = await listAll('_meta/');
for (const name of ['capture.json', 'page.json', 'person.json', 'journal.json', 'manifest.json', 'correction.json']) {
  check(`A2 schemas 含 ${name}`, metaKeys.some((k) => k.includes(`/schemas/`) && k.endsWith(name)));
}
check('A2 registries 当日文件', metaKeys.some((k) => k.startsWith('_meta/registries/')));
check('A2 README 存在', metaKeys.includes('_meta/README.md'));

// ══════════════ A3 登录 ══════════════
console.log('A3 登录');
const login = await api('POST', '/api/v1/auth/login', { body: { email: EMAIL, password: PASSWORD } });
check('A3 正确密码 200', login.status === 200 && !!login.json?.access_token);
const token: string = login.json.access_token;
const bad1 = await api('POST', '/api/v1/auth/login', { body: { email: EMAIL, password: 'wrong-password' } });
const bad2 = await api('POST', '/api/v1/auth/login', { body: { email: 'nobody@local.test', password: 'wrong-password' } });
check('A3 错密码/不存在邮箱均 401 且响应体字节级一致', bad1.status === 401 && bad2.status === 401 && bad1.text === bad2.text);
// B 账号在限流洪水前登录(否则同 IP 60s 窗口内 429,A9 拿不到 token)
execSync('pnpm --silent run seed-account', {
  stdio: 'pipe',
  env: { ...process.env, SEED_EMAIL: 'other@local.test', SEED_PASSWORD: 'other-password-001' },
});
const loginB = await api('POST', '/api/v1/auth/login', { body: { email: 'other@local.test', password: 'other-password-001' } });
const tokenB: string = loginB.json.access_token;
let got429 = false;
for (let i = 0; i < 12; i++) {
  const r = await api('POST', '/api/v1/auth/login', { body: { email: EMAIL, password: 'x'.repeat(8) } });
  if (r.status === 429) got429 = true;
}
check('A3 连发触发 429', got429);

// ══════════════ A4 建档 ══════════════
console.log('A4 建档');
const personRes = await api('POST', '/api/v1/people', {
  token,
  body: {
    display_name: '测试患儿A', birth_date: '2023-08-01', sex_at_birth: 'male', relation_to_owner: 'child',
    allergies: [{ substance: '青霉素', reaction: '皮疹', severity: 'moderate', noted_on: null }],
  },
});
check('A4 建档 201 含 slug', personRes.status === 201 && /^p/.test(personRes.json?.slug ?? ''));
const personId: string = personRes.json.id;
const personSlug: string = personRes.json.slug;
const identRes = await api('POST', `/api/v1/people/${personId}/identifiers`, {
  token,
  body: { facility_id: null, identifier_type: 'patient_id', identifier_value: 'MASKED-001', scope: 'long_term' },
});
check('A4 identifier 201', identRes.status === 201);
const personJson = JSON.parse(await getText(`people/${personSlug}/_person.json`));
check('A4 _person.json 含 id/identifiers/过敏史', personJson.id === personId && personJson.identifiers.length === 1 && personJson.allergies[0].substance === '青霉素');
const journalKeys = await listAll(`people/${personSlug}/journal/`);
check('A4 journal 存在', journalKeys.length === 1);
const journalLines = (await getText(journalKeys[0]!)).trim().split('\n').map((l) => JSON.parse(l));
check('A4 journal person_update 行含 event_id', journalLines.length >= 2 && journalLines.every((l) => l.event === 'person_update' && !!l.event_id));

// ══════════════ A5 / A6 上传链 ══════════════
console.log('A5/A6 上传链');
const { doc, img } = await uploadOneDocument(token, personId, 'accept-a5-000001');
check('A5 登记 201', doc.status === 201, doc.text);
const docId: string = doc.json.id;
const finalPrefix: string = doc.json.pages[0].storage_key.replace(/page-01\.jpg$/, '');
const docDirKeys = await listAll(finalPrefix);
check('A5 目录含 page-01.jpg / page-01.json / capture.json',
  ['page-01.jpg', 'page-01.json', 'capture.json'].every((f) => docDirKeys.includes(finalPrefix + f)));
const manifests = await listAll('_index/manifests/');
const manifestText = manifestsLength(manifests) ? await getText(manifests[0]!) : '';
check('A5 manifests add 行', manifestText.includes(doc.json.short_id));
const incomingLeft = await listAll('_incoming/');
check('A5 _incoming 临时对象已删(current 视图)', incomingLeft.length === 0, incomingLeft.join(','));
function manifestsLength(m: string[]): number { return m.length; }

const capture = JSON.parse(await getText(finalPrefix + 'capture.json'));
check('A6 capture.json 无 AI 观点键', !('doc_type' in capture) && !('facility' in capture) && !('summary' in capture));
check('A6 capture_date 折算正确(Asia/Shanghai)', capture.capture_date === '2026-08-17');
check('A6 person.name 为登记时快照', capture.person?.name === '测试患儿A' && capture.person?.slug === personSlug);
check('A6 幂等 payload 事实字段', capture.client_document_id === 'accept-a5-000001' && capture.original_filename === 'IMG_0001.jpg');

// ══════════════ A7 WORM(真实语义)══════════════
console.log('A7 WORM');
const captureKey = finalPrefix + 'capture.json';
let cond412 = false;
try {
  await app.send(new PutObjectCommand({ Bucket: BUCKET, Key: captureKey, Body: Buffer.from('{}'), IfNoneMatch: '*' }));
} catch (e) {
  cond412 = e instanceof S3ServiceException && [409, 412].includes(e.$metadata.httpStatusCode ?? 0);
}
check('A7 条件 PUT → 412', cond412);
const versionsBefore = await admin.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: captureKey }));
const origVid = versionsBefore.Versions?.find((v) => v.IsLatest)?.VersionId;
await app.send(new PutObjectCommand({ Bucket: BUCKET, Key: captureKey, Body: Buffer.from('{"polluted":true}\n') }));
const versionsAfter = await admin.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: captureKey }));
check('A7 裸 PUT 成功产生新版本(预期行为)', (versionsAfter.Versions?.length ?? 0) === 2);
let lockDenied = false;
try {
  await app.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: captureKey, VersionId: origVid! }));
} catch { lockDenied = true; }
check('A7 删除原版本被拒(锁/策略)', lockDenied);
// 恢复:管理凭证删掉污染版本(未上锁)
const polluted = versionsAfter.Versions?.find((v) => v.IsLatest)?.VersionId;
await admin.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: captureKey, VersionId: polluted! }));
const restored = JSON.parse(await getText(captureKey));
check('A7 恢复后原内容为 current', restored.short_id === doc.json.short_id);

// ══════════════ A8 幂等与崩溃矩阵 ══════════════
console.log('A8 幂等与崩溃矩阵');
await (async () => {
  // 用一个新批次做完整矩阵
  const img2 = fakeJpeg(9);
  const pres = await api('POST', '/api/v1/uploads/presign', {
    token,
    body: { person_id: personId, files: [{ filename: 'IMG_0002.jpg', mime_type: 'image/jpeg', byte_size: img2.length, sha256: sha256hex(img2) }] },
  });
  const up = pres.json.uploads[0];
  await fetch(up.url, { method: 'PUT', headers: up.headers, body: img2 });
  const payload = {
    person_id: personId, person_confirmed: true, batch_id: pres.json.batch_id,
    source: 'camera', captured_at: '2026-08-17T11:00:00+08:00',
    pages: [{ upload_id: up.upload_id, page_no: 1, width: 100, height: 100, sha256: sha256hex(img2) }],
    client_document_id: 'accept-a8-000001',
  };
  // 崩溃注入:after-copy → 500;重试 → 幂等续跑成功
  const crash1 = await api('POST', '/api/v1/documents', { token, body: payload, headers: { 'x-m0-crash-after': 'after-copy' } });
  check('A8 after-copy 注入 → 500', crash1.status === 500);
  const retry1 = await api('POST', '/api/v1/documents', { token, body: payload, headers: { 'x-m0-crash-after': 'after-sidecar' } });
  check('A8 after-sidecar 注入 → 500(页已搬,续跑至 sidecar 后崩)', retry1.status === 500);
  const retry2 = await api('POST', '/api/v1/documents', { token, body: payload });
  check('A8 崩溃后重试 → 201 成功续跑', retry2.status === 201, retry2.text);
  const replaySame = await api('POST', '/api/v1/documents', { token, body: payload });
  check('A8 同幂等键同 payload → 200 同一文档', replaySame.status === 200 && replaySame.json.id === retry2.json.id);
  const replayDiff = await api('POST', '/api/v1/documents', { token, body: { ...payload, source: 'album' } });
  check('A8 同幂等键异 payload → 409', replayDiff.status === 409 && replayDiff.json?.error?.code === 'duplicate_client_document_id');
  const consumed = await api('POST', '/api/v1/documents', { token, body: { ...payload, client_document_id: 'accept-a8-000002' } });
  check('A8 批次二次消费 → 409 upload_consumed', consumed.status === 409 && consumed.json?.error?.code === 'upload_consumed');
})();

// ══════════════ A9 越权 ══════════════
console.log('A9 越权');
const bPerson = await api('GET', `/api/v1/people/${personId}`, { token: tokenB });
const bDoc = await api('GET', `/api/v1/documents/${docId}`, { token: tokenB });
const bPage = await api('GET', `/api/v1/documents/${docId}/pages/1/url`, { token: tokenB });
const missing = await api('GET', `/api/v1/people/00000000-0000-4000-8000-000000000000`, { token: tokenB });
check('A9 B 账号访问 A 的 person/document/页 → 404', bPerson.status === 404 && bDoc.status === 404 && bPage.status === 404, `person=${bPerson.status} doc=${bDoc.status} page=${bPage.status} ${bDoc.text.slice(0, 120)} ${bPage.text.slice(0, 120)}`);
check('A9 无权与不存在响应体一致', bPerson.text === missing.text);
const noAuth = await api('GET', '/api/v1/people');
check('A9 无 token → 401', noAuth.status === 401);

// ══════════════ A12 PATCH 安全 ══════════════
console.log('A12 PATCH');
const patch = await api('PATCH', `/api/v1/people/${personId}`, { token, body: { display_name: '测试患儿A改' } });
check('A12 单字段 PATCH 后过敏史不变', patch.status === 200 && patch.json.allergies.length === 1 && patch.json.allergies[0].substance === '青霉素');
const patchNull = await api('PATCH', `/api/v1/people/${personId}`, { token, body: { blood_type: null } });
check('A12 显式 null 置空', patchNull.status === 200 && patchNull.json.blood_type === null);
await api('PATCH', `/api/v1/people/${personId}`, { token, body: { display_name: '测试患儿A' } });

// ══════════════ A13 拒绝路径 ══════════════
console.log('A13 拒绝路径');
const badMime = await api('POST', '/api/v1/uploads/presign', {
  token, body: { person_id: personId, files: [{ filename: 'x.heic', mime_type: 'image/heic', byte_size: 100, sha256: 'a'.repeat(64) }] },
});
check('A13 非白名单 mime → 400(zod 枚举拒绝)', badMime.status === 400);
const img3 = fakeJpeg(3);
const pres3 = await api('POST', '/api/v1/uploads/presign', {
  token, body: { person_id: personId, files: [{ filename: 'a.jpg', mime_type: 'image/jpeg', byte_size: img3.length + 10, sha256: sha256hex(img3) }] },
});
const up3 = pres3.json.uploads[0];
const putWrongSize = await fetch(up3.url, { method: 'PUT', headers: up3.headers, body: img3 });
// 直传时 sha256 匹配但 byte_size 登记多 10 字节 → ③ file_too_large
if (putWrongSize.status === 200) {
  const reg3 = await api('POST', '/api/v1/documents', {
    token,
    body: {
      person_id: personId, person_confirmed: true, batch_id: pres3.json.batch_id, source: 'camera',
      captured_at: '2026-08-17T12:00:00+08:00',
      pages: [{ upload_id: up3.upload_id, page_no: 1, width: 10, height: 10, sha256: sha256hex(img3) }],
      client_document_id: 'accept-a13-00001',
    },
  });
  check('A13 实测大小与登记不符 → 413', reg3.status === 413, reg3.text);
} else {
  check('A13 实测大小与登记不符(直传即拒)', true);
}
const badBatch = await api('POST', '/api/v1/documents', {
  token,
  body: {
    person_id: personId, person_confirmed: true, batch_id: '00000000-0000-4000-8000-000000000000',
    source: 'camera', captured_at: '2026-08-17T12:00:00+08:00',
    pages: [{ upload_id: '00000000-0000-4000-8000-000000000001', page_no: 1, width: 1, height: 1, sha256: 'a'.repeat(64) }],
    client_document_id: 'accept-a13-00002',
  },
});
check('A13 过期/不存在批次 → 422', badBatch.status === 422 && badBatch.json?.error?.code === 'upload_incomplete');
const futureCapture = await api('POST', '/api/v1/documents', {
  token,
  body: {
    person_id: personId, person_confirmed: true, batch_id: '00000000-0000-4000-8000-000000000000',
    source: 'camera', captured_at: '2099-01-01T00:00:00Z',
    pages: [{ upload_id: '00000000-0000-4000-8000-000000000001', page_no: 1, width: 1, height: 1, sha256: 'a'.repeat(64) }],
    client_document_id: 'accept-a13-00003',
  },
});
check('A13 captured_at 越界 → 400', futureCapture.status === 400);

// ══════════════ B5 journal 并发(两 API 进程)══════════════
console.log('B5 journal 并发');
const before = (await getText(journalKeys[0]!)).trim().split('\n').length;
const tasks: Promise<unknown>[] = [];
for (let i = 0; i < 50; i++) {
  tasks.push(api('PATCH', `/api/v1/people/${personId}`, { token, body: { note: `n${i}` } }));
  tasks.push(
    fetch(`${API2}/api/v1/people/${personId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ note: `m${i}` }),
    }),
  );
}
await Promise.all(tasks);
const after = (await getText(journalKeys[0]!)).trim().split('\n').length;
check('B5 两进程并发 100 次 PATCH → journal 恰 +100 行', after - before === 100, `+${after - before}`);

// ══════════════ A11 + A10 归档与重建 ══════════════
console.log('A11 归档 + A10 重建演练');
const archive = await api('DELETE', `/api/v1/people/${personId}`, { token });
check('A11 归档 200', archive.status === 200);
const listAfter = await api('GET', '/api/v1/people', { token });
check('A11 归档后列表不可见', !listAfter.json.people.some((p: any) => p.id === personId));
const directAfter = await api('GET', `/api/v1/people/${personId}`, { token });
check('A11 归档后直访 404', directAfter.status === 404);
const originalsStill = await listAll(finalPrefix);
check('A11 原件原样在', originalsStill.includes(finalPrefix + 'page-01.jpg'));
const archivedPersonJson = JSON.parse(await getText(`people/${personSlug}/_person.json`));
check('A11 _person.json 含 archived_at(死档不复活的前提)', archivedPersonJson.archived_at !== null);

// A10:dump → drop → migrate → seed → 注入幽灵行 → rebuild → compare
execSync('npx tsx src/verify-rebuild.ts --dump /tmp/m0-snapshot.json', { stdio: 'pipe' });
const REPO_ROOT = process.env.REPO_ROOT ?? new URL('../..', import.meta.url).pathname;
execSync(
  `docker compose -f ${REPO_ROOT}/infra/docker-compose.yml exec -T postgres psql -U amr -d amr -q -c 'drop schema public cascade; create schema public; drop schema if exists drizzle cascade;'`,
  { stdio: 'pipe' },
);
execSync('pnpm --filter @amr/api --silent run db:migrate', { stdio: 'pipe', cwd: REPO_ROOT });
execSync('pnpm --silent run seed-account', { stdio: 'pipe' });
// 注入:重复 event_id 行 + 无佐证 add 行(spec m0-99 A10 注入测试)
const manifestKey = manifests[0]!;
const mText = await getText(manifestKey);
const firstLine = mText.trim().split('\n')[0]!;
const ghost = JSON.stringify({
  schema_version: '1.0', event_id: '00000000-0000-7000-8000-00000000feed', op: 'add',
  doc_short_id: 'dzzzzz', person_slug: personSlug,
  prefix: `people/${personSlug}/2026/2026-01-01__dzzzzz/`, created_at: '2026-01-01T00:00:00.000Z',
});
await admin.send(new PutObjectCommand({
  Bucket: BUCKET, Key: manifestKey,
  Body: Buffer.from(mText + firstLine + '\n' + ghost + '\n', 'utf-8'),
  ContentType: 'application/jsonl',
}));
const rebuildOut = execSync('pnpm --silent run rebuild-index', { encoding: 'utf-8' });
check('A10 rebuild 报告幽灵行进对账', rebuildOut.includes('幽灵行') || rebuildOut.includes('dzzzzz'));
const compare = (() => {
  try {
    return execSync('npx tsx src/verify-rebuild.ts --compare /tmp/m0-snapshot.json', { encoding: 'utf-8' });
  } catch (e: any) {
    return String(e.stdout ?? '') + String(e.stderr ?? '');
  }
})();
check('A10 重建等价性通过(穷尽字段表)', compare.includes('重建等价性通过'), compare.slice(-600));

// ══════════════ 矩阵覆盖:桶内对象 ⊆ 权威矩阵 ══════════════
console.log('矩阵覆盖扫描');
const allKeys = await listAll('');
const unmatched = allKeys.filter((k) => {
  if (k.startsWith('_meta/') || k.startsWith('derived/')) return false;
  try { parseKey(k); return false; } catch { return true; }
});
check('桶内对象 ⊆ 权威矩阵(parseKey 全通过)', unmatched.length === 0, unmatched.slice(0, 5).join(','));

// ══════════════ 汇总 ══════════════
console.log(`\n通过 ${passed} 项;失败 ${failed.length} 项`);
if (failed.length) {
  console.error('失败清单:\n- ' + failed.join('\n- '));
  process.exit(1);
}
console.log('M0 A 组验收全绿');
