// spec m0-99 A10:仅凭桶重建数据库。输入:manifests + capture.json + _person.json + journal。
// 回放规则(与 _meta/README.md 一致):event_id 幂等;重复 add 合并;无 capture.json 佐证的 add → 对账报告。
// 前置:migrations 已跑、seed-account 已跑(account/person_access 显式在重建等价性之外)。
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import {
  CaptureSidecar, CorrectionSidecar, ManifestLine, PersonSidecar,
  correctionSortKey, idempotencyFingerprint,
} from '@amr/contracts';
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
type AddLine = {
  doc_short_id: string;
  person_slug: string;
  prefix: string;
  created_at: string;
  origin: 'capture' | 'split';
};
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
  // 幂等指纹从 capture.json 原样重算 —— 它的每个输入都是 L1 事实。
  // 不重算的话:重建后客户端重放同一 client_document_id 会撞 409 终止(而非 200 命中)。
  const fingerprint = cap.source === 'split' ? null : idempotencyFingerprint({
    person_id: personId,
    person_confirmed: true,
    confirmed_by: cap.person.confirmed_by,
    batch_id: '00000000-0000-7000-8000-000000000000',   // 不进指纹,占位
    source: cap.source,
    captured_at: cap.captured_at,
    client_document_id: cap.client_document_id,
    pages: cap.pages.map((pg) => ({
      upload_id: '00000000-0000-7000-8000-000000000000', // 不进指纹,占位
      page_no: pg.page_no, capture_order: pg.capture_order,
      width: pg.width, height: pg.height, sha256: pg.sha256, exif: null,
    })),
  });
  await sql`
    insert into document (id, short_id, person_id, doc_type, page_count, source, original_filename,
                          captured_at, capture_date, uploaded_by, status, client_document_id, created_at,
                          column_set)
    values (${cap.document_id}, ${shortId}, ${personId}, 'unknown', ${cap.pages.length}, ${cap.source},
            ${cap.original_filename}, ${cap.captured_at}, ${cap.capture_date}, ${cap.uploaded_by}, 'ready',
            ${cap.client_document_id}, ${cap.created_at},
            ${sql.json(fingerprint ? { idem_fingerprint: fingerprint } : {})})
    on conflict (id) do nothing
  `;
  // split capture 的 pages 是跨前缀的原件引用。源 capture 已恢复这些 page 行；
  // 此处只建目标文档骨架，页归属由后面的 page_move correction 转移，避免 storage_key 重复。
  for (const pg of st.origin === 'split' ? [] : cap.pages) {
    const storageKey = pg.file.startsWith('people/') ? pg.file : st.prefix + pg.file;
    await sql`
      insert into document_page (id, document_id, page_no, storage_key, content_sha256, byte_size,
                                 mime_type, width, height, capture_order)
      values (${uuidv7()}, ${cap.document_id}, ${pg.page_no}, ${storageKey}, ${pg.sha256},
              ${pg.bytes}, ${pg.mime}, ${pg.width}, ${pg.height}, ${pg.capture_order})
      on conflict (document_id, page_no) do nothing
    `;
  }
  docsRestored += 1;
}
console.log(`documents restored: ${docsRestored}`);

// ── 4. page_move correction 全局回放 ──
// 人工层 journal/decisions 的完整回放在 m2-07 实现；文档边界不能等到那一步，
// 否则 split 的目标文档永远只有骨架(A21b)。
const correctionKeys = (await listKeys('people/'))
  .filter((key) => /\/correction-\d{4}\.json$/.test(key));
const pageMoves: Array<{ key: string; sidecar: Extract<ReturnType<typeof CorrectionSidecar.parse>, { kind: 'page_move' }> }> = [];
for (const key of correctionKeys) {
  const text = await getText(key);
  if (!text) continue;
  const parsed = CorrectionSidecar.safeParse(JSON.parse(text));
  if (!parsed.success) {
    reconciliation.push(`非法 correction sidecar: ${key}`);
    continue;
  }
  if (parsed.data.kind === 'page_move') pageMoves.push({ key, sidecar: parsed.data });
}
pageMoves.sort((a, b) => correctionSortKey(a.sidecar, a.sidecar.from_doc_short_id)
  .localeCompare(correctionSortKey(b.sidecar, b.sidecar.from_doc_short_id)));

async function normalizeRebuiltPages(documentId: string): Promise<number> {
  const rows = await sql`
    select id from document_page where document_id = ${documentId} order by page_no, id
  `;
  if (rows.length > 0) {
    await sql`update document_page set page_no = page_no + 100000 where document_id = ${documentId}`;
    for (const [index, row] of rows.entries()) {
      await sql`update document_page set page_no = ${index + 1} where id = ${row['id'] as string}`;
    }
  }
  await sql`update document set page_count = ${rows.length} where id = ${documentId}`;
  return rows.length;
}

let movesReplayed = 0;
for (let groupStart = 0; groupStart < pageMoves.length;) {
  const operationId = pageMoves[groupStart]!.sidecar.client_operation_id;
  let groupEnd = groupStart + 1;
  while (groupEnd < pageMoves.length
      && pageMoves[groupEnd]!.sidecar.client_operation_id === operationId) groupEnd += 1;
  const affected = new Map<string, string>();
  for (const { key, sidecar: move } of pageMoves.slice(groupStart, groupEnd)) {
    const source = (await sql`select id from document where short_id = ${move.from_doc_short_id}`)[0];
    const target = (await sql`select id from document where short_id = ${move.to_doc_short_id}`)[0];
    if (!source || !target) {
      reconciliation.push(
        `page_move 文档骨架缺失: ${move.from_doc_short_id} -> ${move.to_doc_short_id} (${key})`,
      );
      continue;
    }
    const sourceId = source['id'] as string;
    const targetId = target['id'] as string;
    affected.set(sourceId, move.corrected_at);
    affected.set(targetId, move.corrected_at);
    let candidates = await sql`
      select id, page_no from document_page
      where document_id = ${sourceId} and content_sha256 = ${move.page_sha256}
        and page_no = ${move.from_page_no}
    `;
    if (candidates.length === 0) {
      candidates = await sql`
        select id, page_no from document_page
        where document_id = ${sourceId} and content_sha256 = ${move.page_sha256}
        order by page_no
      `;
    }
    if (candidates.length === 0) {
      const alreadyMoved = await sql`
        select id from document_page
        where document_id = ${targetId} and content_sha256 = ${move.page_sha256}
          and page_no = ${move.to_page_no}
      `;
      if (alreadyMoved.length > 0) continue;
      reconciliation.push(`page_move 找不到源页: ${move.page_sha256} (${key})`);
      continue;
    }
    if (candidates.length > 1) {
      reconciliation.push(`page_move 摘要在源文档内不唯一: ${move.page_sha256} (${key})`);
      continue;
    }
    await sql`
      update document_page set document_id = ${targetId}, page_no = ${move.to_page_no}
      where id = ${candidates[0]!['id'] as string}
    `;
    movesReplayed += 1;
  }
  // 同一次 split/merge 的所有页移动完成后再重排。若逐页重排，重复内容页的
  // from_page_no 会在操作中途变化，重建可能交换 capture_order 不同的两页。
  for (const [documentId, correctedAt] of affected) {
    const count = await normalizeRebuiltPages(documentId);
    if (count === 0) {
      await sql`
        update document set archived_at = coalesce(archived_at, ${correctedAt})
        where id = ${documentId}
      `;
    }
  }
  groupStart = groupEnd;
}
console.log(`page moves replayed: ${movesReplayed}`);

if (reconciliation.length) {
  console.log('对账报告(需人工处置,不入库):');
  for (const r of reconciliation) console.log('  - ' + r);
}
console.log(JSON.stringify({
  persons: personKeys.length, documents: docsRestored, page_moves: movesReplayed, reconciliation,
}));
await sql.end();
