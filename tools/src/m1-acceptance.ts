// spec m1-99:A 组端到端验收(Playwright)。
// 前置由 infra/run-m1.sh 完成:compose、迁移、provision(含 CORS)、_meta、seed、
// fixtures 生成、web 构建(VITE_M1_TEST_HOOKS=1)、API + 静态服务启动。
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { uuidv7 } from 'uuidv7';
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

/** 纯 API 的单页登记:presign → 直传 → 登记。A6/A7b 需要绕开浏览器精确控制 payload。 */
async function apiRegister(o: {
  token: string; personId: string; fixture: string; clientDocId: string;
  capturedAt: string; exif: unknown;
}): Promise<{ status: number; json: any; text: string }> {
  const meta = FIX[o.fixture]!;
  const bytes = readFileSync(path.join(ROOT, 'fixtures/m1', meta.file));
  const pre = await apiCall('POST', '/api/v1/uploads/presign', o.token, {
    person_id: o.personId,
    files: [{ filename: meta.file, mime_type: meta.mime, byte_size: meta.bytes, sha256: meta.sha256 }],
  });
  if (pre.status >= 300) throw new Error(`presign ${pre.status}: ${pre.text.slice(0, 200)}`);
  const up = pre.json.uploads[0];
  const put = await fetch(up.url, { method: 'PUT', headers: up.headers, body: bytes });
  if (!put.ok) throw new Error(`S3 PUT ${put.status}: ${(await put.text()).slice(0, 200)}`);
  const sharp = (await import('sharp')).default;
  const dim = await sharp(bytes).metadata();
  return apiCall('POST', '/api/v1/documents', o.token, {
    person_id: o.personId, person_confirmed: true, confirmed_by: 'api',
    batch_id: pre.json.batch_id, source: 'album', captured_at: o.capturedAt,
    pages: [{
      upload_id: up.upload_id, page_no: 1, capture_order: 1,
      width: dim.width, height: dim.height, sha256: meta.sha256, exif: o.exif,
    }],
    client_document_id: o.clientDocId,
  });
}

/** 该 person 的文档总数(personId 在 A1 赋值,本函数只在其后调用) */
const docCount = async (t: string): Promise<number> =>
  (await apiCall('GET', `/api/v1/documents?person_id=${personId}&limit=99`, t)).json?.documents?.length ?? -1;

type Snap = Array<{ client_document_id: string; state: string; attempt: number; person_id: string | null; page_count: number; captured_at: string; last_error: unknown }>;
const snapshot = (page: Page) => page.evaluate(() => (globalThis as any).__amr.queueSnapshot() as Promise<Snap>);
const runQueue = (page: Page) => page.evaluate(() => (globalThis as any).__amr.runQueue());
/** 驱动一轮但不被"挂起点"卡死:pauseAt 命中后 tick 永不 settle(这正是它要模拟的进程消失)。 */
const driveQueue = (page: Page) => Promise.race([runQueue(page).catch(() => {}), sleep(1500)]);

const FIXTURE_NAMES = ['photo-plain.png', 'photo-gps-o6.jpg', 'page-1.jpg', 'page-2.jpg', 'page-3.jpg', 'doc-1page.pdf', 'huge.jpg'];
/** 断网前把 fixture 读进内存 —— 注入面用 fetch 取文件,且 reload 会清空该缓存 */
const preload = (p: Page) =>
  p.evaluate((names) => (globalThis as any).__amr.preloadFixtures(names) as Promise<number>, FIXTURE_NAMES);

async function waitForQueue(page: Page, pred: (s: Snap) => boolean, ms = 90_000): Promise<Snap> {
  const t0 = Date.now();
  let last: Snap = [];
  while (Date.now() - t0 < ms) {
    last = await snapshot(page);
    if (pred(last)) return last;
    await driveQueue(page);
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
// 环境预装的浏览器 build 与 playwright 版本可能不匹配 —— 显式指定可执行路径
// (环境约定:PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers,禁止 playwright install)
const CHROME_PATH = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser: Browser = await chromium.launch(
  existsSync(CHROME_PATH) ? { executablePath: CHROME_PATH } : {},
);
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
check('A2 fixture 预加载', (await preload(page)) === FIXTURE_NAMES.length);
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
// 挂起点命中后 tick 永不返回(模拟进程消失)⇒ 只能 fire-and-forget,靠 reload 收场
void page.evaluate(() => (globalThis as any).__amr.runQueue()).catch(() => {});
await waitForQueue(page, (s) => s.some((i) => i.state === 'uploading'), 30_000);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.getByTestId('person-picker').waitFor({ timeout: 20_000 });
snap = await waitForQueue(page, (s) => s.length === 0, 90_000);
check('A5 重载后续跑至完成', snap.length === 0, JSON.stringify(snap.map((s) => [s.state, s.attempt])));
const afterA5 = (await apiCall('GET', `/api/v1/documents?person_id=${personId}&limit=50`, token)).json.documents.length;
check('A5 无重复文档(幂等生效)', afterA5 === 7, `实际 ${afterA5}`);
check('A5 _incoming 无残留', (await listAll('_incoming/')).length === 0);

// ── A6 幂等重放(审核 #002 A-1 的回归测试)──
// 旧口径拿整包 canonical payload 比对 ⇒ 重试必然重新 presign ⇒ batch_id 变 ⇒ 每次重试都 409 终止。
console.log('A6 幂等重放');
const A6_CDID = uuidv7();
const A6_AT = '2024-03-15T08:30:00.000Z';
const r1 = await apiRegister({ token, personId, fixture: 'page-2', clientDocId: A6_CDID, capturedAt: A6_AT, exif: null });
check('A6 首次登记 201', r1.status === 201, `status=${r1.status} ${r1.text.slice(0, 160)}`);
const beforeReplay = await docCount(token);
// 重新 presign(batch_id / upload_id 必变)且换掉 exif —— 三者都不进指纹
const r2 = await apiRegister({
  token, personId, fixture: 'page-2', clientDocId: A6_CDID, capturedAt: A6_AT,
  exif: { captured_at: null, orientation: 3 },
});
check('A6 重放 200 幂等命中(而非 409)', r2.status === 200, `status=${r2.status} code=${r2.json?.error?.code}`);
check('A6 重放返回同一文档', r2.json?.id === r1.json?.id, `${r2.json?.id} vs ${r1.json?.id}`);
check('A6 文档总数不变', (await docCount(token)) === beforeReplay);
// 语义确实变了的 payload 仍须 409 —— 否则幂等就成了"永远命中"
const r3 = await apiRegister({ token, personId, fixture: 'page-3', clientDocId: A6_CDID, capturedAt: A6_AT, exif: null });
check('A6 异 payload 仍 409', r3.status === 409 && r3.json?.error?.code === 'duplicate_client_document_id',
  `status=${r3.status} code=${r3.json?.error?.code}`);

// ── A7b 终止态:保留本地原件,给两个动作 ──
console.log('A7b 终止错误不自动删除');
await page.evaluate(() => (globalThis as any).__amr.enqueueFixture('page-1.jpg'));
const a7bLocal = (await snapshot(page))[0]!.client_document_id;
// 挂到 A6 已登记的 client_document_id 上 ⇒ 登记撞异 payload 409 ⇒ 走产品自己的"未列举 4xx = terminal"
await page.evaluate(
  ([o, n]) => (globalThis as any).__amr.retagClientDocumentId(o, n),
  [a7bLocal, A6_CDID],
);
snap = await waitForQueue(page, (s) => s.some((i) => i.state === 'failed_terminal'), 60_000);
const a7b = snap.find((i) => i.client_document_id === A6_CDID);
check('A7b 停在 failed_terminal', a7b?.state === 'failed_terminal', JSON.stringify(snap.map((s) => s.state)));
const a7bDigest = await page.evaluate((id) => (globalThis as any).__amr.blobDigest(id, 1), A6_CDID);
check('A7b 本地原件未被删除', !!a7bDigest && a7bDigest.sha256 === FIX['page-1']!.sha256, JSON.stringify(a7bDigest));
check('A7b UI 给出"重试"动作', await page.getByTestId(`retry-${A6_CDID}`).count() > 0);
check('A7b UI 给出"放弃"动作', await page.getByTestId(`discard-${A6_CDID}`).count() > 0);

// ── A8 放弃:二次确认 → 上报 journal → 重放只一行 ──
console.log('A8 放弃与上报');
const journalBefore = await listAll(`people/${personSlug}/journal/`);
await page.getByTestId(`discard-${A6_CDID}`).click();
await page.getByTestId(`discard-confirm-${A6_CDID}`).click();
snap = await waitForQueue(page, (s) => !s.some((i) => i.client_document_id === A6_CDID), 60_000);
check('A8 本地已清除', !snap.some((i) => i.client_document_id === A6_CDID), JSON.stringify(snap.map((s) => s.state)));
check('A8 本地 blob 一并清除', (await page.evaluate((id) => (globalThis as any).__amr.blobDigest(id, 1), A6_CDID)) === null);
const journalKeys = await listAll(`people/${personSlug}/journal/`);
check('A8 journal 文件存在', journalKeys.length >= journalBefore.length && journalKeys.length > 0);
const discardLines = () =>
  Promise.all(journalKeys.map(getText)).then((ts) =>
    ts.join('\n').split('\n').filter((l) => l.includes('"capture_discard"')));
let dl = await discardLines();
check('A8 journal 恰一行 capture_discard', dl.length === 1, `${dl.length} 行`);
const discardEvent = dl.length === 1 ? JSON.parse(dl[0]!) : {};
check('A8 该行含 client_document_id 与 event_id',
  discardEvent.client_document_id === A6_CDID && typeof discardEvent.event_id === 'string',
  JSON.stringify(discardEvent).slice(0, 200));
// 重放同一 discard_event_id(客户端补报场景)
const replay = await apiCall('POST', '/api/v1/captures/discard', token, {
  person_id: personId, client_document_id: A6_CDID, discard_event_id: discardEvent.event_id,
  captured_at: A6_AT, page_count: 1, reason: 'terminal_error', detail: null,
});
check('A8 重放 2xx', replay.status < 300, `status=${replay.status} ${replay.text.slice(0, 160)}`);
dl = await discardLines();
check('A8 重放后仍恰一行(服务端幂等)', dl.length === 1, `${dl.length} 行`);

// ── A11 改归属 ──
console.log('A11 改归属');
const personBRes = await apiCall('POST', '/api/v1/people', token, {
  display_name: '测试患儿B', birth_date: '2020-02-02', sex_at_birth: 'female', relation_to_owner: 'child',
});
const personB = { id: personBRes.json.id as string, slug: personBRes.json.slug as string, display_name: '测试患儿B' };
await page.reload({ waitUntil: 'domcontentloaded' });      // 刷新 people_cache
await page.getByTestId('person-picker').waitFor({ timeout: 20_000 });
await page.getByTestId(`person-${personB.slug}`).waitFor({ timeout: 20_000 });
await page.getByTestId(`person-${personSlug}`).click();   // 归属人显式定为 A,后续断言才有确定含义
await preload(page);   // reload 清空了注入面的 fixture 内存缓存
await ctx.setOffline(true);
await page.evaluate(() => (globalThis as any).__amr.enqueueFixture('page-3.jpg'));
const a11Id = (await snapshot(page)).find((s) => s.state === 'pending')!.client_document_id;
await page.getByTestId(`reassign-${a11Id}-${personB.slug}`).click();
await ctx.setOffline(false);
snap = await waitForQueue(page, (s) => s.length === 0, 60_000);
check('A11 改归属后上传完成', snap.length === 0, JSON.stringify(snap.map((s) => [s.state, s.last_error])));
const bKeys = await listAll(`people/${personB.slug}/`);
check('A11 原件落在新归属人前缀下', bKeys.some((k) => /page-01\.jpg$/.test(k)), bKeys.join(',').slice(0, 200));
// uploading 中禁止改:pauseAt('put') 真挂起 ⇒ 该项确定性停在 uploading
await page.evaluate(() => (globalThis as any).__amr.pauseAt('put', 1));
await page.evaluate(() => (globalThis as any).__amr.enqueueFixture('page-2.jpg'));
void page.evaluate(() => (globalThis as any).__amr.runQueue()).catch(() => {});
snap = await waitForQueue(page, (s) => s.some((i) => i.state === 'uploading'), 30_000);
const upId = snap.find((i) => i.state === 'uploading')?.client_document_id;
check('A11 命中挂起点后项停在 uploading', !!upId, JSON.stringify(snap.map((s) => s.state)));
if (upId) {
  const rej = await page.evaluate(
    ([id, p]) => (globalThis as any).__amr.reassign(id, p),
    [upId, personB] as [string, typeof personB],
  );
  check('A11 uploading 中改归属被拒', rej?.ok === false && String(rej.message).includes('不可更改'),
    JSON.stringify(rej));
  check('A11 uploading 项无改归属按钮', await page.getByTestId(`reassign-${upId}-${personB.slug}`).count() === 0);
}
// 重载让挂起的那一项走崩溃恢复,跑完再继续
await page.reload({ waitUntil: 'domcontentloaded' });
await page.getByTestId('person-picker').waitFor({ timeout: 20_000 });
snap = await waitForQueue(page, (s) => s.length === 0, 90_000);
check('A11 挂起项重载后由崩溃恢复续跑完成', snap.length === 0, JSON.stringify(snap.map((s) => [s.state, s.attempt])));

// ── A16 401:队列暂停不清空,重新登录后续跑 ──
console.log('A16 登录失效');
await page.getByTestId(`person-${personSlug}`).click();
await preload(page);
await ctx.setOffline(true);
await page.evaluate(() => (globalThis as any).__amr.enqueueFixture('page-1.jpg'));
const a16Before = (await snapshot(page)).length;
await page.evaluate(() => (globalThis as any).__amr.corruptToken());
await ctx.setOffline(false);
await driveQueue(page);
await page.getByTestId('login-email').waitFor({ timeout: 20_000 });
check('A16 401 后回到登录界面', await page.getByTestId('login-email').count() > 0);
check('A16 token 已清除', (await page.evaluate(() => (globalThis as any).__amr.hasToken())) === false);
const a16Snap = await snapshot(page);
check('A16 队列未被清空', a16Snap.length === a16Before, `${a16Snap.length} vs ${a16Before}`);
const docsBeforeRelogin = await docCount(token);
await page.getByTestId('login-email').fill(EMAIL);
await page.getByTestId('login-password').fill(PASSWORD);
await page.getByTestId('login-submit').click();
await page.getByTestId('person-picker').waitFor({ timeout: 20_000 });
snap = await waitForQueue(page, (s) => s.length === 0, 90_000);
check('A16 重新登录后队列续跑至完成', snap.length === 0, JSON.stringify(snap.map((s) => [s.state, s.last_error])));
check('A16 服务端确实多了一份', (await docCount(token)) === docsBeforeRelogin + 1);

// ── A15 存储配额与持久化降级(独立 context:stub StorageManager)──
console.log('A15 配额与持久化');
const ctx2: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
// ★ 必须走 content 字符串:函数形式会被 esbuild 的 keepNames 插入 __name() 辅助调用,
//   而浏览器里没有该符号 —— init script 会静默 ReferenceError,stub 根本不生效。
//   (quota 100 MiB / usage 99 MiB ⇒ 剩 1 MiB,不足 449 KB 原件的 3 倍)
await ctx2.addInitScript({
  content: `Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      persisted: function () { return Promise.resolve(false); },
      persist: function () { return Promise.resolve(false); },
      estimate: function () { return Promise.resolve({ quota: 104857600, usage: 103809024 }); },
    },
  });`,
});
const page2 = await ctx2.newPage();
await login(page2);
// 先证明 stub 真的生效 —— 否则下面两条断言可能只是"真实环境配额很大所以没报错"
const est = await page2.evaluate(async () => {
  const e = await (navigator as unknown as { storage: { estimate: () => Promise<{ quota?: number; usage?: number }> } })
    .storage.estimate();
  return { quota: e.quota ?? -1, usage: e.usage ?? -1 };
});
check('A15 StorageManager stub 生效', est.quota === 100 * 1024 * 1024 && est.usage === 99 * 1024 * 1024,
  JSON.stringify(est));
check('A15 未获持久化授权时有降级提示', await page2.getByTestId('persist-warning').count() > 0);
await page2.getByTestId('input-album').setInputFiles(path.join(ROOT, 'fixtures/m1/photo-plain.png'));
const quotaMsg = await page2.getByTestId('capture-error').textContent({ timeout: 15_000 }).catch(() => '(未出现)');
check('A15 剩余不足时入队被拒并提示', (quotaMsg ?? '').includes('存储空间不足'), (quotaMsg ?? '').slice(0, 120));
check('A15 被拒项未进队列', (await snapshot(page2)).length === 0);
await ctx2.close();

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
await driveQueue(page);
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
// 只数 API 的 thumb 请求 —— 302 目标是 derived/…/thumb-01.webp,URL 里同样含 "thumb"
page.on('request', (r) => { if (/\/api\/v1\/documents\/[^/]+\/pages\/\d+\/thumb/.test(r.url())) thumbReqs.push(r.url()); });
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

// B3/B4 的取样点:清空重建前先记下派生物字节与源 EXIF
const derivSampleKey = exifDoc ? `derived/${personSlug}/${exifDoc.short_id}/thumb-01.webp` : null;
const derivSha1 = derivSampleKey
  ? createHash('sha256').update(await getBytes(derivSampleKey)).digest('hex')
  : null;

// ── A18 L2 可丢 ──
console.log('A18 L2 可丢');
execSync('npx tsx src/regen-derivatives.ts --purge', { cwd: path.join(ROOT, 'tools'), stdio: 'pipe' });
check('A18 derived 已清空', (await listAll('derived/')).length === 0);
const relazy = await fetch(`${API}/api/v1/documents/${anyDoc.id}/pages/1/thumb?access_token=${token}`, { redirect: 'manual' });
check('A18 惰性路径重新生成', relazy.status === 302 && relazy.headers.get('x-amr-generated') === '1');
execSync('npx tsx src/regen-derivatives.ts --regen', { cwd: path.join(ROOT, 'tools'), stdio: 'pipe' });
check('A18 regen 工具重建成功', (await listAll('derived/')).length > 1);
check('A17 L1 零字节变动(A 组全程)', (await l1Snapshot()) === l1Before);

// ── B3/B4 派生物性质 ──
console.log('B3/B4 派生物性质');
if (derivSampleKey && derivSha1) {
  const derivSha2 = createHash('sha256').update(await getBytes(derivSampleKey)).digest('hex');
  check('B3 派生物确定性(清空重建后字节相同)', derivSha1 === derivSha2, `${derivSha1.slice(0, 12)} vs ${derivSha2.slice(0, 12)}`);
  // B4 强断言:源必须真的带 GPS,否则"派生物无 GPS"是空断言
  const exifr = (await import('exifr')).default;
  const origBytes = readFileSync(path.join(ROOT, 'fixtures/m1', FIX['photo-gps-o6']!.file));
  const srcGps = await exifr.gps(origBytes).catch(() => undefined);
  check('B4 源含 GPS(前置:否则镜像断言为空)',
    typeof srcGps?.latitude === 'number' && typeof srcGps?.longitude === 'number', JSON.stringify(srcGps));
  const derGps = await exifr.gps(await getBytes(derivSampleKey)).catch(() => undefined);
  check('B4 派生物无 GPS', !derGps || derGps.latitude === undefined, JSON.stringify(derGps));
} else {
  check('B3/B4 取样点存在', false, 'exifDoc 缺失');
}

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

// ── A19 重建演练(放最后:要删库)──
console.log('A19 重建演练');
const TOOLS = path.join(ROOT, 'tools');
const sh = (cmd: string, cwd = TOOLS): string => {
  try { return execSync(cmd, { cwd, encoding: 'utf-8', env: { ...process.env, SEED_EMAIL: EMAIL, SEED_PASSWORD: PASSWORD } }); }
  catch (e: any) { return String(e.stdout ?? '') + String(e.stderr ?? ''); }
};
sh('npx tsx src/verify-rebuild.ts --dump /tmp/m1-snapshot.json');
sh(`docker compose -f ${ROOT}/infra/docker-compose.yml exec -T postgres psql -U amr -d amr -q -c 'drop schema public cascade; create schema public; drop schema if exists drizzle cascade;'`, ROOT);
sh('pnpm --filter @amr/api --silent run db:migrate', ROOT);
sh('pnpm --silent run seed-account');
const rebuildOut = sh('pnpm --silent run rebuild-index');
check('A19 rebuild 完成', rebuildOut.includes('documents restored'), rebuildOut.slice(-300));
// capture_discard 是 journal 事件,不是 manifest add —— 不该被当成幽灵行进对账报告
check('A19 capture_discard 不进对账报告', !rebuildOut.includes(A6_CDID), rebuildOut.slice(-300));
const compareOut = sh('npx tsx src/verify-rebuild.ts --compare /tmp/m1-snapshot.json');
check('A19 重建等价性通过(穷尽字段表)', compareOut.includes('重建等价性通过'), compareOut.slice(-600));
console.log(`\n通过 ${passed} 项;失败 ${failed.length} 项`);
if (failed.length) {
  console.error('失败清单:\n- ' + failed.join('\n- '));
  process.exit(1);
}
console.log('M1 A 组验收全绿');
