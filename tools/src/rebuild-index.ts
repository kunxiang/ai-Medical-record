// spec m0-99 A10:仅凭桶重建数据库。输入:manifests + capture.json + _person.json + journal。
// 回放规则(与 _meta/README.md 一致):event_id 幂等;重复 add 合并;无 capture.json 佐证的 add → 对账报告。
// 前置:migrations 已跑、seed-account 已跑(account/person_access 显式在重建等价性之外)。
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import { CaptureSidecar, ManifestLine, PersonSidecar } from '@amr/contracts';
import { adminClient, BUCKET } from './s3-admin.js';

const s3 = adminClient();
const sql = postgres(process.env.DATABASE_URL ?? 'postgres://amr:amr@localhost:5433/amr', {
  max: 1, onnotice: () => {},
});

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function getText(key: string): Promise<string | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await r.Body!.transformToString('utf-8');
  } catch {
    return null;
  }
}

const reconciliation: string[] = [];

// ── 1. 恢复 person(_person.json 全量快照,含 id/identifiers/archived_at)──
const personKeys = (await listKeys('people/')).filter((k) => k.endsWith('/_person.json'));
for (const key of personKeys) {
  const text = await getText(key);
  if (!text) continue;
  const p = PersonSidecar.parse(JSON.parse(text));
  await sql`
    insert into person (id, slug, display_name, name_pinyin, birth_date, sex_at_birth, gender,
                        relation_to_owner, blood_type, allergies, chronic_conditions, note,
                        created_at, updated_at, archived_at)
    values (${p.id}, ${p.slug}, ${p.display_name}, ${p.name_pinyin}, ${p.birth_date},
            ${p.sex_at_birth}, ${p.gender}, ${p.relation_to_owner}, ${p.blood_type},
            ${sql.json(p.allergies)}, ${sql.json(p.chronic_conditions)}, ${p.note},
            ${p.created_at}, ${p.updated_at}, ${p.archived_at})
    on conflict (id) do nothing
  `;
  for (const i of p.identifiers) {
    await sql`
      insert into person_identifier (id, person_id, facility_id, identifier_type, identifier_value, scope)
      values (${i.id}, ${p.id}, ${i.facility_id}, ${i.identifier_type}, ${i.identifier_value}, ${i.scope})
      on conflict (id) do nothing
    `;
  }
}
console.log(`persons restored: ${personKeys.length}`);

// ── 2. manifests 回放(event_id 幂等 → 文档)──
const manifestKeys = (await listKeys('_index/manifests/')).sort();
const seenEventIds = new Set<string>();
type AddLine = { doc_short_id: string; person_slug: string; prefix: string; created_at: string };
const docState = new Map<string, AddLine & { finalSlug: string }>();
for (const key of manifestKeys) {
  const text = await getText(key);
  if (!text) continue;
  for (const raw of text.split('\n').filter(Boolean)) {
    const parsed = ManifestLine.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      reconciliation.push(`非法 manifest 行 (${key}): ${raw.slice(0, 120)}`);
      continue;
    }
    const line = parsed.data;
    if (seenEventIds.has(line.event_id)) continue; // 幂等
    seenEventIds.add(line.event_id);
    if (line.op === 'add') {
      const prev = docState.get(line.doc_short_id);
      docState.set(line.doc_short_id, {
        ...line, finalSlug: prev?.finalSlug ?? line.person_slug,
      });
    } else {
      const prev = docState.get(line.doc_short_id);
      if (prev) prev.finalSlug = line.to_person_slug;
      else reconciliation.push(`person_correct 无前置 add: ${line.doc_short_id}`);
    }
  }
}

// ── 3. 逐文档:capture.json 佐证 → 插 document + document_page ──
const slugToPersonId = new Map<string, string>(
  (await sql`select id, slug from person`).map((r) => [r['slug'] as string, r['id'] as string]),
);
const accountIds = new Set<string>((await sql`select id from account`).map((r) => r['id'] as string));
let docsRestored = 0;
for (const [shortId, st] of docState) {
  const captureKey = `${st.prefix}capture.json`;
  const text = await getText(captureKey);
  if (!text) {
    reconciliation.push(`add 行无 capture.json 佐证(幽灵行?): ${shortId} @ ${st.prefix}`);
    continue;
  }
  const cap = CaptureSidecar.parse(JSON.parse(text));
  const personId = slugToPersonId.get(st.finalSlug);
  if (!personId) {
    reconciliation.push(`文档归属 slug 无对应 person: ${shortId} -> ${st.finalSlug}`);
    continue;
  }
  // uploaded_by 占位账号(审核 #001 #6:account 不在重建等价性内)
  if (!accountIds.has(cap.uploaded_by)) {
    await sql`
      insert into account (id, email, password_hash, display_name)
      values (${cap.uploaded_by}, ${'rebuilt+' + cap.uploaded_by.slice(0, 8) + '@local.invalid'}, '!', '重建占位账号')
      on conflict (id) do nothing
    `;
    accountIds.add(cap.uploaded_by);
  }
  await sql`
    insert into document (id, short_id, person_id, doc_type, page_count, source, original_filename,
                          captured_at, capture_date, uploaded_by, status, client_document_id, created_at)
    values (${cap.document_id}, ${shortId}, ${personId}, 'unknown', ${cap.pages.length}, ${cap.source},
            ${cap.original_filename}, ${cap.captured_at}, ${cap.capture_date}, ${cap.uploaded_by}, 'ready',
            ${cap.client_document_id}, ${cap.created_at})
    on conflict (id) do nothing
  `;
  for (const pg of cap.pages) {
    await sql`
      insert into document_page (id, document_id, page_no, storage_key, content_sha256, byte_size,
                                 mime_type, width, height, capture_order)
      values (${uuidv7()}, ${cap.document_id}, ${pg.page_no}, ${st.prefix + pg.file}, ${pg.sha256},
              ${pg.bytes}, ${pg.mime}, ${pg.width}, ${pg.height}, ${pg.page_no})
      on conflict (document_id, page_no) do nothing
    `;
  }
  docsRestored += 1;
}
console.log(`documents restored: ${docsRestored}`);

if (reconciliation.length) {
  console.log('对账报告(需人工处置,不入库):');
  for (const r of reconciliation) console.log('  - ' + r);
}
console.log(JSON.stringify({ persons: personKeys.length, documents: docsRestored, reconciliation }));
await sql.end();
