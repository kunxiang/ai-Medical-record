import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { AuditLine, JournalEvent, ManifestLine } from '@amr/contracts';
import { buildKey, canonicalJsonl, serverTimestamp, utcYearMonth } from '@amr/storage';
import type { Tx } from './db/client.js';
import { appendJsonl } from './s3.js';

/** 追加 journal 行:调用方必须在 DB 事务内、且本调用是 COMMIT 前最后动作之一。
 *  advisory lock 主锁 + S3 条件写防御(spec m0-03 §5.4)。 */
export async function appendJournal(
  tx: Tx,
  personSlug: string,
  event: Record<string, unknown> & { at?: string },
): Promise<void> {
  const full = JournalEvent.parse({ ...event, event_id: uuidv7(), at: event.at ?? serverTimestamp() });
  const { year, month } = utcYearMonth(full.at);
  const key = buildKey.journal({ personSlug, year, month });
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  await appendJsonl(key, canonicalJsonl(full));
}

export async function appendManifest(tx: Tx, line: Record<string, unknown>): Promise<void> {
  const full = ManifestLine.parse({ ...line, event_id: uuidv7() });
  const { year, month } = utcYearMonth(full.created_at);
  const key = buildKey.manifest({ year, month });
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  await appendJsonl(key, canonicalJsonl(full));
}

/** 系统级审计(D11,m1-02 §5):权限授予/撤销 → _index/audit/{YYYY-MM}.jsonl。
 *  与 journal 分开:它记的是权限变更,不是人工判断。 */
export async function appendAudit(tx: Tx, line: Record<string, unknown>): Promise<void> {
  const full = AuditLine.parse({ ...line, event_id: uuidv7() });
  const { year, month } = utcYearMonth(full.at);
  const key = `_index/audit/${year}-${month}.jsonl`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  await appendJsonl(key, canonicalJsonl(full));
}
