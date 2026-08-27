// M2 A1–A8/A10 的隔离集成切片。由 infra/run-m2.sh 在固定 p23456/d23456 fixture 上执行。
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { S1Artifact, dedupKey } from '@amr/contracts';
import { buildKey } from '@amr/storage';
import { db, sqlClient } from './db/client.js';
import { aiJob, document, normalizationDecision } from './db/schema.js';
import { getObjectBytes, getObjectText } from './s3.js';
import { enqueue, reclaimZombies } from './jobs/queue.js';
import { tickOnce } from './jobs/worker.js';

const PERSON_ID = '018f0000-0000-7000-8000-000000000101';
const DOC_SHORT_ID = 'd23456';
let passed = 0;
const failed: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed.push(name); console.error(`  ✗ ${name} ${detail}`); }
}

const target = (await db.select().from(document).where(eq(document.shortId, DOC_SHORT_ID)).limit(1))[0];
if (!target) throw new Error(`固定验收文档不存在: ${DOC_SHORT_ID}`);
const mismatchDocument = (await db.select().from(document).where(eq(document.shortId, 'd23457')).limit(1))[0];
const reuseDocument = (await db.select().from(document).where(eq(document.shortId, 'd23458')).limit(1))[0];
if (!mismatchDocument || !reuseDocument) throw new Error('固定验收文档 d23457/d23458 不完整');
const initialJobs = await db.select().from(aiJob).where(and(
  eq(aiJob.documentId, target.id), eq(aiJob.kind, 'stage1'),
));
check('A3 登记同事务投递唯一 pending stage1 job',
  initialJobs.length === 1 && initialJobs[0]!.state === 'pending', JSON.stringify(initialJobs));

const rollbackDocumentId = '018f0000-0000-7000-8000-000000000109';
try {
  await db.transaction(async (tx) => {
    await tx.insert(document).values({
      id: rollbackDocumentId, shortId: 'd23459', personId: target.personId,
      pageCount: 1, source: 'camera', capturedAt: new Date('2026-08-27T00:00:00.000Z'),
      captureDate: '2026-08-27', uploadedBy: target.uploadedBy, status: 'ready',
      clientDocumentId: 'm2-rollback-document',
    });
    await enqueue(tx, {
      kind: 'stage1', dedupKey: dedupKey.stage1(rollbackDocumentId),
      documentId: rollbackDocumentId, personId: target.personId,
    });
    throw new Error('intentional rollback');
  });
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'intentional rollback') throw error;
}
const rollbackDocuments = await db.select().from(document).where(eq(document.id, rollbackDocumentId));
const rollbackJobs = await db.select().from(aiJob).where(eq(aiJob.documentId, rollbackDocumentId));
check('A3 登记事务回滚时 document 与 job 同时不存在',
  rollbackDocuments.length === 0 && rollbackJobs.length === 0,
  `documents=${rollbackDocuments.length} jobs=${rollbackJobs.length}`);

await db.transaction((tx) => enqueue(tx, {
  kind: 'stage1', dedupKey: dedupKey.stage1(target.id), documentId: target.id, personId: target.personId,
}));
const duplicateCount = await db.select().from(aiJob).where(and(
  eq(aiJob.documentId, target.id), eq(aiJob.kind, 'stage1'),
));
check('A7 重复投递仍只有一条 job', duplicateCount.length === 1, `count=${duplicateCount.length}`);

const zombie = (await db.select().from(aiJob).where(and(
  eq(aiJob.kind, 'stage1'), eq(aiJob.documentId, mismatchDocument.id),
)).limit(1))[0];
if (!zombie) throw new Error('缺少僵尸回收验收 job');
await db.update(aiJob).set({
  state: 'running', lockedAt: new Date(Date.now() - 20 * 60_000), lockedBy: 'dead-worker', attempt: 2,
}).where(eq(aiJob.id, zombie.id));
check('A8 僵尸回收器命中一条', await reclaimZombies('m2-acceptance') === 1);
const reclaimed = (await db.select().from(aiJob).where(eq(aiJob.id, zombie.id)).limit(1))[0]!;
check('A8 僵尸回到 pending 且 attempt +1',
  reclaimed.state === 'pending' && reclaimed.attempt === 3,
  `state=${reclaimed.state} attempt=${reclaimed.attempt}`);

// 只让固定文档进入本轮，其他 stage1 job 留给后续恢复演练。
await sqlClient`
  update ai_job set next_attempt_at = now() + interval '1 day'
  where kind = 'stage1' and document_id <> ${target.id}
`;
await tickOnce('m2-stage1-acceptance', 1);

const completed = (await db.select().from(aiJob).where(eq(aiJob.id, initialJobs[0]!.id)).limit(1))[0]!;
const updated = (await db.select().from(document).where(eq(document.id, target.id)).limit(1))[0]!;
check('A4 Stage 1 job 到 done 且 result_key 非空',
  completed.state === 'done' && completed.resultKey !== null,
  `state=${completed.state} result=${completed.resultKey} error=${JSON.stringify(completed.lastError)}`);
check('A5 派生列落库且 person_id 逐字节未改',
  updated.docType !== 'unknown' && updated.s1ArtifactKey !== null && updated.personId === PERSON_ID,
  `doc_type=${updated.docType} person=${updated.personId}`);
check('A10 合成报告姓名与成员一致时 person_check=match', updated.personCheck === 'match', updated.personCheck);

const derivativeKey = buildKey.derivative({
  personSlug: 'p23456', docShortId: DOC_SHORT_ID, variant: 'ai', pageNo: 1,
});
const derivative = await getObjectBytes(derivativeKey);
if (!derivative) throw new Error(`AI 派生图不存在: ${derivativeKey}`);
const metadata = await sharp(derivative).metadata();
check('A1 ai-01.webp 存在、Orientation=6 已旋正、长边受限且无 EXIF',
  (metadata.height ?? 0) > (metadata.width ?? 0)
    && Math.max(metadata.width ?? 0, metadata.height ?? 0) <= 2576
    && metadata.exif === undefined,
  JSON.stringify({ width: metadata.width, height: metadata.height, exif: !!metadata.exif }));

const artifactObject = completed.resultKey ? await getObjectText(completed.resultKey) : null;
const artifact = artifactObject ? S1Artifact.parse(JSON.parse(artifactObject.text)) : null;
check('A4 S1 工件含六项追溯字段', !!artifact
  && !!artifact.model && !!artifact.prompt_id && artifact.prompt_version >= 1
  && /^[0-9a-f]{64}$/.test(artifact.prompt_sha256) && !!artifact.effort && !!artifact.usage,
  completed.resultKey ?? '无 result key');
const structuredOutput = artifact ? {
  ...artifact.output,
  pages: artifact.output.pages.map(({ full_text: _fullText, ...page }) => page),
} : null;
check('A9b 全部结构化字段不含手机号/身份证', !!structuredOutput
  && !/(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dXx](?!\d)/.test(JSON.stringify(structuredOutput)));

const fullTexts = artifact?.output.pages.map((page) => page.full_text).filter(Boolean) ?? [];
const databaseColumns = await sqlClient`
  select table_name, column_name
  from information_schema.columns
  where table_schema = 'public' and is_generated = 'NEVER'
  order by table_name, ordinal_position
`;
const fullTextLeaks: string[] = [];
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
for (const row of databaseColumns) {
  const table = String(row['table_name']);
  const column = String(row['column_name']);
  for (const fullText of fullTexts) {
    const hit = await sqlClient.unsafe(
      `select exists(select 1 from ${quoteIdentifier(table)} where ${quoteIdentifier(column)}::text like $1) as hit`,
      [`%${fullText}%`],
    );
    if (hit[0]?.['hit'] === true) fullTextLeaks.push(`${table}.${column}`);
  }
}
check('A6 full_text 只存在 S1 工件，PostgreSQL 全列扫描无全文命中',
  fullTexts.length > 0 && fullTextLeaks.length === 0,
  JSON.stringify(fullTextLeaks));

// facility job 比第二份 stage1 更早创建，先延后它，确保下一轮处理 mismatch fixture。
await sqlClient`update ai_job set next_attempt_at = now() + interval '1 day' where kind = 'facility_normalize'`;
await db.update(aiJob).set({ state: 'pending', nextAttemptAt: new Date() }).where(eq(aiJob.id, zombie.id));
await tickOnce('m2-mismatch-acceptance', 1);
const mismatchAfter = (await db.select().from(document).where(eq(document.id, mismatchDocument.id)).limit(1))[0]!;
check('A11 姓名不一致时 mismatch 且 person_id 未改',
  mismatchAfter.personCheck === 'mismatch' && mismatchAfter.personId === PERSON_ID,
  `check=${mismatchAfter.personCheck} person=${mismatchAfter.personId}`);

await sqlClient`update ai_job set next_attempt_at = now() where kind = 'facility_normalize'`;
const callLog = process.env.AMR_AI_CALL_LOG;
const callsBeforeFirstFacility = callLog ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean).length : -1;
await tickOnce('m2-facility-acceptance', 1);
const callsAfterFirstFacility = callLog ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean).length : -1;
const facilityDecisions = await db.select().from(normalizationDecision)
  .where(eq(normalizationDecision.kind, 'facility'));
const normalizedDocs = await db.select().from(document).where(eq(document.personId, PERSON_ID));
check('A15 首次 facility 调 AI、写 proposed 决策并回填已处理文档',
  callsAfterFirstFacility === callsBeforeFirstFacility + 1
    && facilityDecisions.length === 1 && facilityDecisions[0]!.state === 'proposed'
    && normalizedDocs.filter((row) => row.shortId !== 'd23458').every((row) => row.facilityId !== null),
  `calls=${callsBeforeFirstFacility}->${callsAfterFirstFacility} decisions=${facilityDecisions.length}`);

const callsBeforeReuse = callLog ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean).length : -1;
const reuseJob = (await db.select().from(aiJob).where(and(
  eq(aiJob.kind, 'stage1'), eq(aiJob.documentId, reuseDocument.id),
)).limit(1))[0]!;
await sqlClient`update ai_job set next_attempt_at = now() + interval '1 day' where kind = 'encounter_suggest'`;
await db.update(aiJob).set({ state: 'pending', nextAttemptAt: new Date() }).where(eq(aiJob.id, reuseJob.id));
await tickOnce('m2-facility-reuse-acceptance', 1);
const reuseAfter = (await db.select().from(document).where(eq(document.id, reuseDocument.id)).limit(1))[0]!;
const callsAfterReuse = callLog ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean).length : -1;
const facilityJobs = await db.select().from(aiJob).where(eq(aiJob.kind, 'facility_normalize'));
check('A16 同指纹文档直接复用决策，除自身 S1 外不再调用 facility AI',
  reuseAfter.facilityId !== null && facilityJobs.length === 1
    && callsAfterReuse === callsBeforeReuse + 1,
  `facility_jobs=${facilityJobs.length} calls=${callsBeforeReuse}->${callsAfterReuse}`);

console.log(`通过 ${passed} 项;失败 ${failed.length} 项`);
await sqlClient.end();
if (failed.length) {
  console.error('失败清单:\n- ' + failed.join('\n- '));
  process.exit(1);
}
console.log('Stage 1 集成验收全绿');
