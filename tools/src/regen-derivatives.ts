// spec m1-03 §5:删光 derived/** 后按 DB 遍历重生成 —— "L2 可丢"的执行体之一。
// ⚠️ 删除 derived/** 必须用 admin 凭证:应用策略只给 _incoming/* 与 _probe/* 的删除权。
import { DeleteObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import postgres from 'postgres';
import sharp from 'sharp';
import { buildKey } from '@amr/storage';
import { adminClient, BUCKET } from './s3-admin.js';

const s3 = adminClient();
const sql = postgres(process.env.DATABASE_URL ?? 'postgres://amr:amr@localhost:5432/amr', {
  max: 1, onnotice: () => {},
});

const mode = process.argv[2] ?? '--regen';   // --purge | --regen | --purge-then-regen

async function purge(): Promise<number> {
  let n = 0;
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  do {
    const r = await s3.send(new ListObjectVersionsCommand({
      Bucket: BUCKET, Prefix: 'derived/', KeyMarker: keyMarker, VersionIdMarker: versionMarker,
    }));
    for (const v of [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])]) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: v.Key!, VersionId: v.VersionId! }));
      n += 1;
    }
    keyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
    versionMarker = r.IsTruncated ? r.NextVersionIdMarker : undefined;
  } while (keyMarker);
  return n;
}

async function regen(): Promise<number> {
  const rows = await sql`
    select dp.storage_key, dp.page_no, dp.mime_type, d.short_id, p.slug as person_slug
    from document_page dp
    join document d on d.id = dp.document_id
    join person p on p.id = d.person_id
    order by dp.storage_key`;
  let n = 0;
  for (const row of rows) {
    if (row['mime_type'] === 'application/pdf') continue;   // D13
    const src = await s3.send(new (await import('@aws-sdk/client-s3')).GetObjectCommand({
      Bucket: BUCKET, Key: row['storage_key'] as string,
    }));
    const bytes = Buffer.from(await src.Body!.transformToByteArray());
    for (const [variant, maxEdge] of [['thumb', 400], ['preview', 1600]] as const) {
      const out = await sharp(bytes, { failOn: 'error' })
        .rotate()
        .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toBuffer();
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: buildKey.derivative({
          personSlug: row['person_slug'] as string, docShortId: row['short_id'] as string,
          variant, pageNo: row['page_no'] as number,
        }),
        Body: out, ContentType: 'image/webp',      // ★ 不上锁
      }));
      n += 1;
    }
  }
  return n;
}

sharp.concurrency(1);
if (mode === '--purge' || mode === '--purge-then-regen') console.log(`purged ${await purge()} derived objects`);
if (mode === '--regen' || mode === '--purge-then-regen') console.log(`regenerated ${await regen()} derivatives`);
await sql.end();
