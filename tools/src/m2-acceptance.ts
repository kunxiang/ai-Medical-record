// M2 07/99 A33–A35:人工层恢复演练。前置由 infra/run-m2.sh 建立洁净 PG/MinIO/API。
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import postgres from 'postgres';
import sharp from 'sharp';
import { uuidv7 } from 'uuidv7';
import {
  canonicalJsonString, DECISION_OP_REGISTRY, JOURNAL_EVENT_REGISTRY, normalizeIdentity,
} from '@amr/contracts';
import { adminClient, BUCKET } from './s3-admin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = process.env.API_URL ?? 'http://localhost:58300';
const EMAIL = process.env.SEED_EMAIL ?? 'owner@local.test';
const PASSWORD = process.env.SEED_PASSWORD ?? 'm0-acceptance-password';
const PERSON_ID = '018f0000-0000-7000-8000-000000000101';
const PERSON_SLUG = 'p23456';
const TEMP_DIR = process.env.AMR_M2_TMP_DIR ?? '/tmp';
const BEFORE_SNAPSHOT = path.join(TEMP_DIR, 'before.json');
const FIRST_SNAPSHOT = path.join(TEMP_DIR, 'first.json');
const COMPOSE_PROJECT = process.env.AMR_M2_COMPOSE_PROJECT ?? 'amr-m2-acceptance';
const COMPOSE_OVERRIDE = process.env.AMR_M2_COMPOSE_OVERRIDE
  ?? path.join(ROOT, 'infra/docker-compose.m2-acceptance.yml');
mkdirSync(TEMP_DIR, { recursive: true });
const admin = adminClient();
const sql = postgres(process.env.DATABASE_URL ?? 'postgres://amr:amr@localhost:64321/amr', {
  max: 1, onnotice: () => {},
});

let passed = 0;
const failed: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed.push(name); console.error(`  ✗ ${name} ${detail}`); }
}

async function api(method: string, route: string, token: string | null, body?: unknown) {
  const response = await fetch(API + route, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* response may be empty */ }
  return { status: response.status, text, json };
}

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const result = await admin.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    for (const object of result.Contents ?? []) if (object.Key) keys.push(object.Key);
    token = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function lineCount(prefix: string): Promise<number> {
  let count = 0;
  for (const key of await listKeys(prefix)) {
    const object = await admin.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const text = await object.Body!.transformToString('utf8');
    count += text.split('\n').filter(Boolean).length;
  }
  return count;
}

async function jsonlRows(prefix: string): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const key of await listKeys(prefix)) {
    const text = await objectText(key);
    for (const line of text.split('\n').filter(Boolean)) rows.push(JSON.parse(line));
  }
  return rows;
}

async function objectText(key: string): Promise<string> {
  const object = await admin.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return object.Body!.transformToString('utf8');
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const facilityFingerprint = (rawName: string) => sha256(canonicalJsonString({
  raw_name: normalizeIdentity(rawName),
}));

async function syntheticJpeg(seed: number): Promise<Buffer> {
  const image = sharp({
    create: {
      width: 1200, height: 800, channels: 3,
      background: { r: 180 + seed, g: 210 - seed, b: 235 },
    },
  });
  if (seed === 1) image.withMetadata({ orientation: 6 });
  return image.jpeg({ quality: 95 }).toBuffer();
}

async function uploadDocument(token: string, personId: string, index: number) {
  const bytes = await syntheticJpeg(index + 1);
  const digest = sha256(bytes);
  const presign = await api('POST', '/api/v1/uploads/presign', token, {
    person_id: personId,
    files: [{
      filename: `m2-replay-${index}.jpg`, mime_type: 'image/jpeg',
      byte_size: bytes.length, sha256: digest,
    }],
  });
  if (presign.status !== 200) throw new Error(`presign ${presign.status}: ${presign.text}`);
  const deterministicShortId = `d2345${index + 6}`;
  await sql`update upload_batch set doc_short_id = ${deterministicShortId} where id = ${presign.json.batch_id}`;
  const upload = presign.json.uploads[0];
  const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
  if (!put.ok) throw new Error(`PUT ${put.status}: ${await put.text()}`);
  const created = await api('POST', '/api/v1/documents', token, {
    person_id: personId, person_confirmed: true, confirmed_by: 'api',
    batch_id: presign.json.batch_id, source: 'camera', captured_at: `2026-08-2${index}T08:00:00Z`,
    pages: [{
      upload_id: upload.upload_id, page_no: 1, capture_order: 1,
      width: 100, height: 100, sha256: digest, exif: null,
    }],
    client_document_id: `m2-replay-document-${index}`,
  });
  if (created.status !== 201) throw new Error(`document ${created.status}: ${created.text}`);
  return created.json as { id: string; short_id: string };
}

function sh(command: string, cwd = ROOT): string {
  return execSync(command, {
    cwd, encoding: 'utf8',
    env: { ...process.env, SEED_EMAIL: EMAIL, SEED_PASSWORD: PASSWORD },
  });
}

console.log('B5 _meta 事件注册完整性');
const registryKey = (await listKeys('_meta/registries/'))[0];
if (!registryKey) throw new Error('未生成 _meta/registries');
const registry = JSON.parse(await objectText(registryKey)) as {
  journal_events?: string[]; decision_ops?: string[];
};
const readme = await objectText('_meta/README.md');
const journalSchema = await objectText('_meta/schemas/1.0/journal.json');
const decisionSchema = await objectText('_meta/schemas/1.0/decision.json');
const m2JournalEvents = [
  'person_check_ack', 'person_reassign', 'document_archive',
  'document_split', 'document_merge', 'document_move_page',
];
const m2DecisionOps = ['normalization_confirm'];
check('B5 M2 七类人工事件在 schema/registry/README 三处齐备',
  m2JournalEvents.every((event) =>
    JOURNAL_EVENT_REGISTRY.includes(event as typeof JOURNAL_EVENT_REGISTRY[number])
      && registry.journal_events?.includes(event)
      && journalSchema.includes(`\"${event}\"`)
      && readme.includes(`\`${event}\``))
    && m2DecisionOps.every((op) =>
      DECISION_OP_REGISTRY.includes(op as typeof DECISION_OP_REGISTRY[number])
        && registry.decision_ops?.includes(op)
        && decisionSchema.includes(`\"${op}\"`)
        && readme.includes(`\`${op}\``)),
);

console.log('A33 准备人工层事实');
const login = await api('POST', '/api/v1/auth/login', null, { email: EMAIL, password: PASSWORD });
if (login.status !== 200) throw new Error(`login ${login.status}: ${login.text}`);
const token: string = login.json.access_token;
const accountId = (await sql`select id from account where email = ${EMAIL}`)[0]!['id'] as string;
const personAt = '2026-08-27T00:00:00.000Z';
await sql`
  insert into person
    (id, slug, display_name, birth_date, sex_at_birth, relation_to_owner,
     allergies, chronic_conditions, note, created_at, updated_at)
  values
    (${PERSON_ID}, ${PERSON_SLUG}, 'P1', '2018-01-02', 'female', 'child',
     ${sql.json([])}, ${sql.json([])}, '', ${personAt}, ${personAt})
`;
await sql`insert into person_access (account_id, person_id, role) values (${accountId}, ${PERSON_ID}, 'owner')`;
await admin.send(new PutObjectCommand({
  Bucket: BUCKET,
  Key: `people/${PERSON_SLUG}/_person.json`,
  ContentType: 'application/json',
  Body: JSON.stringify({
    schema_version: '1.0', id: PERSON_ID, slug: PERSON_SLUG, display_name: 'P1',
    name_pinyin: null, birth_date: '2018-01-02', sex_at_birth: 'female', gender: null,
    relation_to_owner: 'child', blood_type: null, allergies: [], chronic_conditions: [], note: '',
    created_at: personAt, updated_at: personAt, archived_at: null, identifiers: [],
  }),
}));
const personId = PERSON_ID;
const documents = await Promise.all([0, 1, 2].map((index) => uploadDocument(token, personId, index)));

console.log('A1–A8（不含 A9）/A10 Stage 1 cassette 集成切片');
const stage1Run = sh('pnpm --filter @amr/api --silent exec tsx src/m2-stage1-acceptance.ts');
check('A1–A8/A9b/A10–A11/A15–A16 Stage 1 cassette 集成切片通过',
  stage1Run.includes('Stage 1 集成验收全绿'), stage1Run.slice(-1000));
const mismatchList = await api(
  'GET', `/api/v1/documents?person_id=${encodeURIComponent(personId)}&person_check=mismatch`, token,
);
check('A11 mismatch 查询能列出不一致文档', mismatchList.status === 200
  && mismatchList.json.documents.some((item: { short_id: string }) => item.short_id === 'd23457'),
  mismatchList.text.slice(0, 300));

const facilities = [
  { raw: 'M2测试第一医院', slug: 'f23456', name: 'M2测试第一医院', city: '测试市' },
  { raw: 'M2测试第二医院', slug: 'f23457', name: 'M2测试第二医院', city: '测试市' },
];
const decisionIds: string[] = [];
for (const [index, input] of facilities.entries()) {
  const fingerprint = facilityFingerprint(input.raw);
  const decisionId = uuidv7();
  decisionIds.push(decisionId);
  const proposal = {
    facility: { slug: input.slug, name: input.name, city: input.city, level: '三级' },
    matched_raw_names: [input.raw, `${input.raw}别名`], confidence: 0.99, reason: '合成验收词表',
  };
  await sql`update document set facility_name_raw = ${input.raw} where id = ${documents[index]!.id}`;
  if (index === 0) {
    await sql`update document set facility_name_raw = ${input.raw} where id = ${documents[2]!.id}`;
  }
  await sql`
    insert into normalization_decision
      (id, kind, input_fingerprint, proposal, state, created_at)
    values (${decisionId}, 'facility', ${fingerprint}, ${sql.json(proposal)}, 'proposed', now())
  `;
  const confirmed = await api(
    'POST', `/api/v1/normalization-decisions/${decisionId}/confirm`, token,
    { decision: 'confirmed', client_operation_id: uuidv7() },
  );
  check(`A33 机构归一确认 ${index + 1}`, confirmed.status === 200, confirmed.text.slice(0, 200));
}

const encounterFacilityId = (await sql`
  select facility_id from document where id = ${documents[0]!.id}
`)[0]!['facility_id'] as string;
const encounterDecisionId = uuidv7();
const encounterId = uuidv7();
const encounterProposal = {
  encounter_id: encounterId,
  person_id: personId,
  document_ids: [documents[0]!.id, documents[2]!.id],
  document_short_ids: [documents[0]!.short_id, documents[2]!.short_id],
  facility_id: encounterFacilityId,
  grouping_basis: 'event_time', encounter_type: 'outpatient',
  occurred_on: '2026-08-20', occurred_at: '2026-08-20T08:00:00Z',
  department: '儿科', confidence: 0.98, reason: '合成验收归组',
};
await sql`
  insert into normalization_decision
    (id, kind, input_fingerprint, proposal, state, created_at)
  values (${encounterDecisionId}, 'encounter', ${sha256(canonicalJsonString(encounterProposal))},
          ${sql.json(encounterProposal)}, 'proposed', now())
`;
const encounterConfirmed = await api(
  'POST', `/api/v1/normalization-decisions/${encounterDecisionId}/confirm`, token,
  { decision: 'confirmed', client_operation_id: uuidv7() },
);
check('A33 encounter 人工确认写入可回放快照',
  encounterConfirmed.status === 200, encounterConfirmed.text.slice(0, 240));
const decisionLines = await jsonlRows('_index/decisions/');
check('A17 facility 确认写入 confirmed 状态与 normalization_confirm L1 决策流',
  decisionLines.filter((line) => line['op'] === 'normalization_confirm' && line['kind'] === 'facility').length === 2,
  JSON.stringify(decisionLines));

await sql`update document set person_check = 'mismatch' where id in (${documents[0]!.id}, ${documents[1]!.id})`;
for (const [index, document] of documents.slice(0, 2).entries()) {
  const ack = await api('POST', `/api/v1/documents/${document.id}/person-check/ack`, token, {
    reason: '合成验收告警确认', client_operation_id: uuidv7(),
  });
  check(`A33 归人告警确认 ${index + 1}`, ack.status === 200, ack.text.slice(0, 200));
}
const ackState = (await sql`
  select count(*)::int as count from document
  where id in (${documents[0]!.id}, ${documents[1]!.id})
    and person_check = 'mismatch' and person_check_ack_at is not null
`)[0]!['count'] as number;
const ackLines = (await jsonlRows(`people/${PERSON_SLUG}/journal/`))
  .filter((line) => line['event'] === 'person_check_ack');
check('A12 ack 保留 mismatch、写时间戳且 journal 恰两行并含姓名快照',
  ackState === 2 && ackLines.length === 2
    && ackLines.every((line) => 'observed_name' in line && 'expected_name' in line),
  `db=${ackState} journal=${ackLines.length}`);
for (const [index, document] of documents.entries()) {
  const archived = await api('PATCH', `/api/v1/documents/${document.id}`, token, {
    archived: true, reason: '合成验收归档', client_operation_id: uuidv7(),
  });
  check(`A33 文档归档 ${index + 1}`, archived.status === 200, archived.text.slice(0, 200));
}

const beforeCounts = {
  journal: await lineCount('people/'),
  decisions: await lineCount('_index/decisions/'),
};
const originalAiJobs = Number((await sql`select count(*)::int as count from ai_job`)[0]!['count']);
check('A34 前置确实存在可丢的 AI jobs', originalAiJobs >= 3, `count=${originalAiJobs}`);
const aiCallLog = process.env.AMR_AI_CALL_LOG;
const aiCallsBeforeRebuild = aiCallLog
  ? readFileSync(aiCallLog, 'utf8').split('\n').filter(Boolean).length
  : -1;
check('A34 已建立 rebuild 前 transport 调用计数快照', aiCallsBeforeRebuild >= 1,
  aiCallLog ?? '未配置调用日志');
await sql.end();

console.log('A33/A34 删库重建');
sh(`pnpm --filter @amr/tools --silent exec tsx src/verify-rebuild.ts --dump ${JSON.stringify(BEFORE_SNAPSHOT)}`);
sh(
  `docker compose -p ${COMPOSE_PROJECT} -f ${path.join(ROOT, 'infra/docker-compose.yml')} ` +
  `-f ${COMPOSE_OVERRIDE} exec -T postgres ` +
  "psql -U amr -d amr -q -c 'drop schema public cascade; create schema public; drop schema if exists drizzle cascade;'",
);
sh('pnpm --filter @amr/api --silent run db:migrate');
sh('pnpm --filter @amr/tools --silent run seed-account');
const firstRebuild = sh('pnpm --filter @amr/tools --silent run rebuild-index');
check('A33 首次 rebuild 回放 8 条人工事实', firstRebuild.includes('human events replayed: 8'), firstRebuild.slice(-600));
const firstCompare = sh(
  `pnpm --filter @amr/tools --silent exec tsx src/verify-rebuild.ts --compare ${JSON.stringify(BEFORE_SNAPSHOT)}`,
);
check('A33 三件套逐字段恢复', firstCompare.includes('重建等价性通过'), firstCompare.slice(-600));

const rebuiltSql = postgres(process.env.DATABASE_URL ?? 'postgres://amr:amr@localhost:64321/amr', {
  max: 1, onnotice: () => {},
});
const restored = (await rebuiltSql`
  select
    (select count(*)::int from document where archived_at is not null) as archived,
    (select count(*)::int from document where person_check_ack_at is not null) as acked,
    (select count(*)::int from normalization_decision where state = 'confirmed') as confirmed,
    (select count(*)::int from facility where cardinality(aliases) = 2) as facilities,
    (select count(*)::int from encounter where grouping_basis = 'event_time') as encounters,
    (select count(*)::int from ai_job) as jobs
`)[0]!;
check('A33 归档/ack/归一/别名数量正确',
  restored['archived'] === 3 && restored['acked'] === 2
    && restored['confirmed'] === 3 && restored['facilities'] === 2 && restored['encounters'] === 1,
  JSON.stringify(restored));
check('A34 rebuild 未恢复或投递 ai_job', restored['jobs'] === 0, `count=${restored['jobs']}`);
const aiCallsAfterRebuild = aiCallLog
  ? readFileSync(aiCallLog, 'utf8').split('\n').filter(Boolean).length
  : -1;
check('A34 rebuild 新增 transport 调用计数为 0', aiCallsAfterRebuild === aiCallsBeforeRebuild,
  `before=${aiCallsBeforeRebuild} after=${aiCallsAfterRebuild}`);
await rebuiltSql.end();

console.log('A35 幂等与只读 L1');
sh(`pnpm --filter @amr/tools --silent exec tsx src/verify-rebuild.ts --dump ${JSON.stringify(FIRST_SNAPSHOT)}`);
const secondRebuild = sh('pnpm --filter @amr/tools --silent run rebuild-index');
check('A35 第二次 rebuild 完成', secondRebuild.includes('human events replayed: 8'), secondRebuild.slice(-400));
const secondCompare = sh(
  `pnpm --filter @amr/tools --silent exec tsx src/verify-rebuild.ts --compare ${JSON.stringify(FIRST_SNAPSHOT)}`,
);
check('A35 两次 rebuild 结果逐字段相同', secondCompare.includes('重建等价性通过'), secondCompare.slice(-600));
const afterCounts = {
  journal: await lineCount('people/'),
  decisions: await lineCount('_index/decisions/'),
};
check('A35 rebuild 不写回 journal/decisions',
  JSON.stringify(afterCounts) === JSON.stringify(beforeCounts),
  `before=${JSON.stringify(beforeCounts)} after=${JSON.stringify(afterCounts)}`);

const rebuildSource = readFileSync(path.join(ROOT, 'tools/src/rebuild-index.ts'), 'utf8');
check('B15 rebuild 不读取 L2 extraction', !/extractions|Stage1Out/.test(rebuildSource));

console.log(`\n通过 ${passed} 项;失败 ${failed.length} 项`);
if (failed.length) {
  console.error('失败清单:\n- ' + failed.join('\n- '));
  process.exit(1);
}
console.log('M2 人工层回放验收全绿');
