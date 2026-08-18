// spec m1-99:A 组端到端验收(Playwright)。
// 前置由 infra/run-m1.sh 完成:compose、迁移、provision(含 CORS)、_meta、seed、
// fixtures 生成、web 构建(VITE_M1_TEST_HOOKS=1)、API + 静态服务启动。
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { chromium, type Browser, type Page } from 'playwright';
import { parseKey } from '@amr/storage';
import { adminClient, BUCKET } from './s3-admin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = process.env.API_URL ?? 'http://localhost:8300';
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const EMAIL = process.env.SEED_EMAIL ?? 'owner@local.test';
const PASSWORD = process.env.SEED_PASSWORD ?? 'm0-acceptance-password';
const admin = adminClient();
const FIX = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/m1/manifest.json'), 'utf-8')) as
  Record<string, { file: string; sha256: string; bytes: number; mime: string }>;

let passed = 0;
const failed: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed.push(name); console.error(`  ✗ ${name} ${detail}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
const getText = async (key: string) =>
  (await admin.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))).Body!.transformToString('utf-8');
const getBytes = async (key: string) =>
  Buffer.from(await (await admin.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))).Body!.transformToByteArray());

/** people/** 的 (Key,VersionId,ETag) 全量清单 —— L1 零字节变动的取证手段 */
async function l1Snapshot(): Promise<string> {
  const rows: string[] = [];
  let km: string | undefined, vm: string | undefined;
  do {
    const r = await admin.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: 'people/', KeyMarker: km, VersionIdMarker: vm }));
    for (const v of r.Versions ?? []) rows.push(`${v.Key}|${v.VersionId}|${v.ETag}`);
    km = r.IsTruncated ? r.NextKeyMarker : undefined;
    vm = r.IsTruncated ? r.NextVersionIdMarker : undefined;
  } while (km);
  return rows.sort().join('\n');
}

async function apiCall(method: string, p: string, token: string | null, body?: unknown) {
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
  return { status: r.status, json, text, headers: r.headers };
}

type Snap = Array<{ client_document_id: string; state: string; attempt: number; person_id: string | null; page_count: number; captured_at: string; last_error: unknown }>;
const snapshot = (page: Page) => page.evaluate(() => (globalThis as any).__amr.queueSnapshot() as Promise<Snap>);
const runQueue = (page: Page) => page.evaluate(() => (globalThis as any).__amr.runQueue());

async function waitForQueue(page: Page, pred: (s: Snap) => boolean, ms = 90_000): Promise<Snap> {
  const t0 = Date.now();
  let last: Snap = [];
  while (Date.now() - t0 < ms) {
    last = await snapshot(page);
    if (pred(last)) return last;
    await runQueue(page).catch(() => {});
    await sleep(700);
  }
  return last;
}

async function login(page: Page): Promise<void> {
  await page.goto(WEB, { waitUntil: 'networkidle' });
  if (await page.getByTestId('login-email').count()) {
    await page.getByTestId('login-email').fill(EMAIL);
    await page.getByTestId('login-password').fill(PASSWORD);
    await page.getByTestId('login-submit').click();
  }
  await page.getByTestId('person-picker').waitFor({ timeout: 20_000 });
}

// ════════════════════════════ 开始 ════════════════════════════
const browser: Browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('    [browser]', m.text().slice(0, 200)); });

// ── A0 环境自检:安全上下文 + 跨源预检 ──
console.log('A0 环境自检');
await page.goto(WEB);
check('A0 安全上下文', await page.evaluate(() => (globalThis as any).isSecureContext as boolean), 'localhost 应为可信来源');
const pre = await fetch(`${API}/api/v1/documents`, {
  method: 'OPTIONS',
  headers: { origin: WEB, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,content-type' },
});
check('A0 API 跨源预检', pre.status < 300 && pre.headers.get('access-control-allow-origin') === WEB,
  `status=${pre.status} allow-origin=${pre.headers.get('access-control-allow-origin')}`);

// ── A1 登录 + 人员缓存 ──
console.log('A1 登录与人员选择器');
const tokenRes = await apiCall('POST', '/api/v1/auth/login', null, { email: EMAIL, password: PASSWORD });
const token: string = tokenRes.json.access_token;
const personRes = await apiCall('POST', '/api/v1/people', token, {
  display_name: '测试患儿A', birth_date: '2023-08-01', sex_at_birth: 'male', relation_to_owner: 'child',
  allergies: [{ substance: '青霉素', reaction: '皮疹', severity: 'moderate', noted_on: null }],
});
const personId: string = personRes.json.id;
const personSlug: string = personRes.json.slug;
await login(page);
check('A1 选择器列出档案', await page.getByTestId(`person-${personSlug}`).count() > 0);
const cachedFields = await page.evaluate(async () => {
  const g = globalThis as any;
  const req = g.indexedDB.open('amr-capture');
  const d: any = await new Promise((res) => { req.onsuccess = () => res(req.result); });
  return new Promise<string[]>((res) => {
    const tx = d.transaction('people_cache').objectStore('people_cache').getAll();
    tx.onsuccess = () => res(Object.keys(tx.result[0] ?? {}));
  });
});
check('A1 people_cache 不含医疗 PII', !cachedFields.includes('allergies') && !cachedFields.includes('birth_date'),
  cachedFields.join(','));

// ── A2 离线拍 5 张 ──
console.log('A2 离线采集');
await ctx.setOffline(true);
await page.evaluate(() => (globalThis as any).__amr.enqueueFixture('photo-plain.png', { count: 5 }));
let snap = await snapshot(page);
check('A2 队列 5 条且状态 pending', snap.length === 5 && snap.every((s) => s.state === 'pending'), JSON.stringify(snap.map(s=>s.state)));
check('A2 client_document_id 唯一', new Set(snap.map((s) => s.client_document_id)).size === 5);
await page.getByTestId('queue-count').waitFor();
check('A2 UI 显示 5 张待上传', (await page.getByTestId('queue-count').textContent())?.includes('5') === true);
check('A2 文案未承诺后台上传', !((await page.getByTestId('queue-hint').textContent()) ?? '').includes('关掉'));

// ── A3 离线刷新:崩溃恢复 + blob 完整性 ──
console.log('A3 离线刷新');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.getByTestId('person-picker').waitFor({ timeout: 20_000 });
snap = await snapshot(page);
check('A3 刷新后队列仍 5 条', snap.length === 5, `实际 ${snap.length}`);
const digest = await page.evaluate((id) => (globalThis as any).__amr.blobDigest(id, 1), snap[0]!.client_document_id);
check('A3 blob 已物化且可读(byte_size 与实际一致)',
  !!digest && digest.byte_size === digest.actual_size && digest.byte_size === FIX['photo-plain']!.bytes,
  JSON.stringify(digest));
check('A3 blob sha256 与 fixture 已知值一致', digest?.sha256 === FIX['photo-plain']!.sha256);

// ── A4 恢复网络 → 全部上传 ──
console.log('A4 恢复网络');
const t0 = Date.now();
await ctx.setOffline(false);
snap = await waitForQueue(page, (s) => s.length === 0, 90_000);
check('A4 队列清空(done 为瞬态)', snap.length === 0, `剩余 ${snap.length}: ${JSON.stringify(snap.map(s=>[s.state,s.last_error]))}`);
const docs = await apiCall('GET', `/api/v1/documents?person_id=${personId}&limit=50`, token);
check('A4 服务端 5 份文档', docs.json?.documents?.length === 5, `实际 ${docs.json?.documents?.length}`);
const pageKeys = (await listAll(`people/${personSlug}/`)).filter((k) => /page-01\.(png|jpg)$/.test(k));
let allSha = pageKeys.length === 5;
for (const k of pageKeys) {
  const b = await getBytes(k);
  if (createHash('sha256').update(b).digest('hex') !== FIX['photo-plain']!.sha256) allSha = false;
}
check('A4 原件 sha256 == fixture 已知值(原件字节零改动)', allSha, `keys=${pageKeys.length}`);
const manifestKeys = await listAll('_index/manifests/');
const manifestText = manifestKeys.length ? await getText(manifestKeys[0]!) : '';
check('A4 manifests 恰增 5 条 add 行',
  manifestText.split('\n').filter((l) => l.includes('"op":"add"')).length === 5);
check('A4 60 秒内完成', Date.now() - t0 < 60_000, `${Math.round((Date.now() - t0) / 1000)}s`);

// ── A4b EXIF 时间 + confirmed_by ──
console.log('A4b EXIF 与 confirmed_by');
await page.evaluate(() => (globalThis as any).__amr.enqueueFixture('photo-gps-o6.jpg'));
snap = await waitForQueue(page, (s) => s.length === 0, 60_000);
const exifDoc = (await apiCall('GET', `/api/v1/documents?person_id=${personId}&limit=50`, token))
  .json.documents.find((d: any) => d.capture_date === '2023-05-01');
check('A4b EXIF DateTimeOriginal 生效(capture_date=2023-05-01)', !!exifDoc, '旧单据不得落在今天');
if (exifDoc) {
  const prefix = `people/${personSlug}/2023/2023-05-01__${exifDoc.short_id}/`;
  const cap = JSON.parse(await getText(prefix + 'capture.json'));
  check('A4b confirmed_by === capture_ui', cap.person?.confirmed_by === 'capture_ui', cap.person?.confirmed_by);
  check('A4b capture_order 已落 L1', cap.pages?.[0]?.capture_order === 1);
  const pageJson = JSON.parse(await getText(prefix + 'page-01.json'));
  check('A4b page sidecar 含 exif.orientation=6', pageJson.exif?.orientation === 6, JSON.stringify(pageJson.exif));
  const orig = await getBytes(prefix + 'page-01.jpg');
  check('A4b 原件 sha256 与 fixture 一致(EXIF 完整保留)',
    createHash('sha256').update(orig).digest('hex') === FIX['photo-gps-o6']!.sha256);

  // A4c 派生物:旋正 + 无 EXIF
  const thumb = await apiCall('GET', `/api/v1/documents/${exifDoc.id}/pages/1/thumb`, token);
  check('A4c thumb 首次生成', thumb.status === 200 || thumb.status === 302);
  const derivKeys = await listAll(`derived/${personSlug}/${exifDoc.short_id}/`);
  check('A4c 派生物已落 derived/', derivKeys.some((k) => k.endsWith('thumb-01.webp')), derivKeys.join(','));
  const head = await admin.send(new HeadObjectCommand({ Bucket: BUCKET, Key: `derived/${personSlug}/${exifDoc.short_id}/thumb-01.webp` }));
  check('A4c 派生物未上锁(L2)', !head.ObjectLockMode, String(head.ObjectLockMode));
  const tb = await getBytes(`derived/${personSlug}/${exifDoc.short_id}/thumb-01.webp`);
  const sharp = (await import('sharp')).default;
  const tmeta = await sharp(tb).metadata();
  check('A4c Orientation=6 已旋正(1200x800 → 竖向)', (tmeta.height ?? 0) > (tmeta.width ?? 0), `${tmeta.width}x${tmeta.height}`);
  check('A4c 派生物无 EXIF/GPS', !tmeta.exif);
}

// ── A5 上传中途重载 ──
console.log('A5 上传中途重载');
await page.evaluate(() => (globalThis as any).__amr.pauseAt('put', 1));
await page.evaluate(() => (globalThis as any).__amr.enqueueFixture('page-1.jpg'));
await runQueue(page).catch(() => {});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.getByTestId('person-picker').waitFor({ timeout: 20_000 });
snap = await waitForQueue(page, (s) => s.length === 0, 90_000);
check('A5 重载后续跑至完成', snap.length === 0, JSON.stringify(snap.map((s) => [s.state, s.attempt])));
const afterA5 = (await apiCall('GET', `/api/v1/documents?person_id=${personId}&limit=50`, token)).json.documents.length;
check('A5 无重复文档(幂等生效)', afterA5 === 7, `实际 ${afterA5}`);
check('A5 _incoming 无残留', (await listAll('_incoming/')).length === 0);

// ── A9 连拍多页 ──
console.log('A9 连拍三页');
await page.evaluate(async () => {
  const a = (globalThis as any).__amr;
  await a.enqueueFixture('page-1.jpg', { asOneDocument: true, count: 1 });
});
// 三页需按序追加到同一 draft:用 count=3 + asOneDocument
await page.evaluate(() => (globalThis as any).__amr.enqueueFixture('page-2.jpg', { asOneDocument: true, count: 3 }));
snap = await waitForQueue(page, (s) => s.length === 0, 90_000);
const listAfter = (await apiCall('GET', `/api/v1/documents?person_id=${personId}&limit=50`, token)).json.documents;
const multi = listAfter.find((d: any) => d.page_count === 3);
check('A9 一份文档 3 页', !!multi, `page_counts=${listAfter.map((d: any) => d.page_count).join(',')}`);
if (multi) {
  const docDir = (await listAll(`people/${personSlug}/`)).filter((k) => k.includes(`__${multi.short_id}/`));
  check('A9 桶内 page-01/02/03 三件套',
    ['page-01', 'page-02', 'page-03'].every((p) => docDir.some((k) => k.includes(p))), docDir.length + ' objects');
}

// ── A7 超限拒绝 ──
console.log('A7 超限与终止错误');
const rejected = await page.evaluate(async () => {
  try { await (globalThis as any).__amr.enqueueFixture('huge.jpg'); return 'accepted'; }
  catch (e) { return String((e as Error).message).slice(0, 80); }
});
check('A7 >50MiB 在入队前被拒', rejected !== 'accepted', rejected);
check('A7 队列未被污染', (await snapshot(page)).length === 0);

// ── A10 pending_person ──
console.log('A10 先拍后选');
await page.evaluate(() => (globalThis as any).__amr.enqueueFixture('photo-plain.png', { personId: null }));
snap = await snapshot(page);
check('A10 无归属人时为 pending_person', snap[0]?.state === 'pending_person', snap[0]?.state);
await runQueue(page);
check('A10 pending_person 不发起上传', (await snapshot(page))[0]?.state === 'pending_person');
await page.getByTestId('needs-person').waitFor({ timeout: 5000 }).catch(() => {});
check('A10 UI 有待归人红条', await page.getByTestId('needs-person').count() > 0);
const pid = (await snapshot(page))[0]!.client_document_id;
await page.getByTestId(`reassign-${pid}-${personSlug}`).click();
snap = await waitForQueue(page, (s) => s.length === 0, 60_000);
check('A10 选人后上传成功', snap.length === 0, JSON.stringify(snap.map((s) => s.state)));

// ── A12 浏览与懒加载 ──
console.log('A12 浏览');
await page.getByTestId('tab-browse').click();
await page.getByTestId('browse').waitFor();
const thumbReqs: string[] = [];
page.on('request', (r) => { if (r.url().includes('/thumb')) thumbReqs.push(r.url()); });
await sleep(2500);
const cards = await page.locator('[data-testid^="doc-"]').count();
check('A12 时间轴渲染文档卡片', cards > 0, `cards=${cards}`);
check('A12 缩略图请求数受控(懒加载)', thumbReqs.length <= cards + 2, `req=${thumbReqs.length} cards=${cards}`);

// ── A13 惰性生成标记 ──
console.log('A13 惰性生成');
const anyDoc = listAfter[0];
const first = await fetch(`${API}/api/v1/documents/${anyDoc.id}/pages/1/thumb?access_token=${token}`, { redirect: 'manual' });
const second = await fetch(`${API}/api/v1/documents/${anyDoc.id}/pages/1/thumb?access_token=${token}`, { redirect: 'manual' });
check('A13 302 重定向', first.status === 302 && second.status === 302, `${first.status}/${second.status}`);
check('A13 第二次 generated=0', second.headers.get('x-amr-generated') === '0',
  `first=${first.headers.get('x-amr-generated')} second=${second.headers.get('x-amr-generated')}`);

// ── A14 PDF ──
console.log('A14 PDF');
await page.getByTestId('tab-capture').click();
await page.evaluate(() => (globalThis as any).__amr.enqueueFixture('doc-1page.pdf'));
snap = await waitForQueue(page, (s) => s.length === 0, 60_000);
const pdfDoc = (await apiCall('GET', `/api/v1/documents?person_id=${personId}&limit=60`, token))
  .json.documents.find((d: any) => d.first_page?.mime_type === 'application/pdf');
check('A14 PDF 上传成功', !!pdfDoc);
if (pdfDoc) {
  const r = await apiCall('GET', `/api/v1/documents/${pdfDoc.id}/pages/1/thumb`, token);
  check('A14 PDF 缩略图返回 415', r.status === 415, `status=${r.status}`);
}

// ── A17 L1 基线(此后只做 L2 活动)──
const l1Before = await l1Snapshot();

// ── A18 L2 可丢 ──
console.log('A18 L2 可丢');
execSync('pnpm --silent run regen-derivatives -- --purge', { cwd: path.join(ROOT, 'tools'), stdio: 'pipe' });
check('A18 derived 已清空', (await listAll('derived/')).length === 0);
const relazy = await fetch(`${API}/api/v1/documents/${anyDoc.id}/pages/1/thumb?access_token=${token}`, { redirect: 'manual' });
check('A18 惰性路径重新生成', relazy.status === 302 && relazy.headers.get('x-amr-generated') === '1');
execSync('npx tsx src/regen-derivatives.ts --regen', { cwd: path.join(ROOT, 'tools'), stdio: 'pipe' });
check('A18 regen 工具重建成功', (await listAll('derived/')).length > 1);
check('A17 L1 零字节变动(A 组全程)', (await l1Snapshot()) === l1Before);

// ── A20 矩阵覆盖 ──
console.log('A20 矩阵覆盖');
const all = await listAll('');
const unmatched = all.filter((k) => {
  if (k.startsWith('_meta/')) return false;
  try { parseKey(k); return false; } catch { return true; }
});
check('A20 桶内对象 ⊆ 权威矩阵', unmatched.length === 0, unmatched.slice(0, 5).join(','));

// ── B9/B10 到期设计债 ──
console.log('B9/B10 设计债清偿');
const auditKeys = await listAll('_index/audit/');
const auditText = auditKeys.length ? await getText(auditKeys[0]!) : '';
check('B10(D11)审计有 access_grant 行', auditText.includes('"op":"access_grant"'));
execSync('pnpm --silent run seed-account', {
  cwd: path.join(ROOT, 'tools'), stdio: 'pipe',
  env: { ...process.env, SEED_EMAIL: EMAIL, SEED_PASSWORD: PASSWORD },
});
const afterRotate = await apiCall('GET', `/api/v1/documents?person_id=${personId}`, token);
check('B9(D12)改密码后旧 token 立即 401', afterRotate.status === 401, `status=${afterRotate.status}`);

await browser.close();
console.log(`\n通过 ${passed} 项;失败 ${failed.length} 项`);
if (failed.length) {
  console.error('失败清单:\n- ' + failed.join('\n- '));
  process.exit(1);
}
console.log('M1 A 组验收全绿');
