// spec m0-99 A10:穷尽字段比对。--dump snapshot.json(删库前)/ --compare snapshot.json(重建后)。
// 排除:account、person_access(显式边界,审核 #001 #6)。
import { writeFileSync, readFileSync } from 'node:fs';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL ?? 'postgres://amr:amr@localhost:5433/amr', {
  max: 1, onnotice: () => {},
});

// 穷尽字段表(spec m0-99 A10)
async function snapshot() {
  const people = await sql`
    select id, slug, display_name, name_pinyin, birth_date::text, sex_at_birth, gender,
           relation_to_owner, blood_type, allergies, chronic_conditions, note,
           archived_at is not null as archived
    from person order by slug`;
  const identifiers = await sql`
    select id, person_id, facility_id, identifier_type, identifier_value, scope
    from person_identifier order by id`;
  const documents = await sql`
    select id, short_id, person_id, capture_date::text, captured_at, source,
           original_filename, status, client_document_id, encounter_id,
           archived_at, person_check_ack_at
    from document order by short_id`;
  // M2 只自动产生建议；每一行 encounter 都来自人工确认，因此 id 的存在与
  // grouping_basis 都属于不可重算事实。其他列没有在 m2-01 §5 标为 L1。
  const encounters = await sql`
    select id, person_id, encounter_type, facility_id, department, occurred_on::text,
           occurred_at, grouping_basis
    from encounter order by id`;
  // facility 表里 proposed-only 的行可由 L2 重算。这里只对账至少被一条
  // confirmed decision 引用的家庭词表项。
  const facilities = await sql`
    select f.slug, f.name, f.aliases, f.city, f.level
    from facility f
    where exists (
      select 1 from normalization_decision nd
      where nd.kind = 'facility' and nd.state = 'confirmed'
        and nd.proposal -> 'facility' ->> 'slug' = f.slug
    )
    order by f.slug`;
  const decisions = await sql`
    select kind, input_fingerprint, proposal, state, decided_by, decided_at, client_operation_id
    from normalization_decision where state <> 'proposed'
    order by input_fingerprint`;
  // thumb_key 不在字段表(m1-99 A19):它是 L2 派生物的位置,M1 根本不写它,
  // 比对一个恒为 null 的列只会制造"看起来通过了"的噪声。
  const pages = await sql`
    select document_id, page_no, storage_key, content_sha256, byte_size, mime_type,
           width, height, page_label, capture_order
    from document_page order by storage_key`;
  return {
    people: people.map((r) => ({ ...r })),
    identifiers: identifiers.map((r) => ({ ...r })),
    documents: documents.map((r) => ({
      ...r,
      captured_at: (r['captured_at'] as Date).toISOString(),
      archived_at: r['archived_at'] instanceof Date ? r['archived_at'].toISOString() : null,
      person_check_ack_at: r['person_check_ack_at'] instanceof Date
        ? r['person_check_ack_at'].toISOString()
        : null,
    })),
    encounters: encounters.map((r) => ({
      ...r,
      occurred_at: r['occurred_at'] instanceof Date ? r['occurred_at'].toISOString() : null,
    })),
    facilities: facilities.map((r) => ({
      ...r,
      aliases: [...r['aliases'] as string[]].sort(),
    })),
    decisions: decisions.map((r) => ({
      ...r,
      decided_at: r['decided_at'] instanceof Date ? r['decided_at'].toISOString() : null,
    })),
    pages: pages.map((r) => ({ ...r })),
  };
}

const mode = process.argv[2];
const file = process.argv[3] ?? 'snapshot.json';
const snap = await snapshot();

if (mode === '--dump') {
  writeFileSync(file, JSON.stringify(snap, null, 1));
  console.log(`snapshot dumped: ${file} (${snap.people.length} people, ${snap.documents.length} docs)`);
} else if (mode === '--compare') {
  const before = JSON.parse(readFileSync(file, 'utf-8')) as typeof snap;
  const diffs: string[] = [];
  for (const table of [
    'people', 'identifiers', 'documents', 'encounters', 'facilities', 'decisions', 'pages',
  ] as const) {
    const a = JSON.stringify(before[table]);
    const b = JSON.stringify(snap[table]);
    if (a !== b) {
      diffs.push(table);
      console.error(`✗ ${table} 不一致`);
      console.error(`  before: ${a.slice(0, 400)}`);
      console.error(`  after : ${b.slice(0, 400)}`);
    } else {
      console.log(`✓ ${table} 一致(${snap[table].length} 行)`);
    }
  }
  if (diffs.length) {
    console.error(`重建等价性失败: ${diffs.join(', ')}`);
    process.exit(1);
  }
  console.log('重建等价性通过(A10)');
} else {
  console.error('用法: verify-rebuild --dump|--compare [file]');
  process.exit(2);
}
await sql.end();
