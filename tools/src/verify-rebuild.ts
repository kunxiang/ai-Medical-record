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
           original_filename, status, client_document_id
    from document order by short_id`;
  // thumb_key 不在字段表(m1-99 A19):它是 L2 派生物的位置,M1 根本不写它,
  // 比对一个恒为 null 的列只会制造"看起来通过了"的噪声。
  const pages = await sql`
    select document_id, page_no, storage_key, content_sha256, byte_size, mime_type,
           width, height, page_label, capture_order
    from document_page order by storage_key`;
  return {
    people: people.map((r) => ({ ...r })),
    identifiers: identifiers.map((r) => ({ ...r })),
    documents: documents.map((r) => ({ ...r, captured_at: (r['captured_at'] as Date).toISOString() })),
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
  for (const table of ['people', 'identifiers', 'documents', 'pages'] as const) {
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
