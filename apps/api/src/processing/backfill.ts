import type { ProcessingCapabilityT } from '@amr/contracts';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { document } from '../db/schema.js';
import { env } from '../env.js';
import { scheduleDocumentMetadata } from './scheduling.js';

/**
 * 根据 L1/DB 当前投影补齐文档元数据建议任务。它不依赖旧 ai_job，重复运行只会命中 dedup。
 */
export async function backfillDocumentProcessing(
  capability: Extract<ProcessingCapabilityT, 'document_metadata_suggest'> = 'document_metadata_suggest',
): Promise<number> {
  if (env.processingMode !== 'assist') return 0;
  if (capability !== 'document_metadata_suggest') return 0;
  const documents = await db.select({ id: document.id, personId: document.personId }).from(document)
    .where(and(
      eq(document.status, 'ready'),
      isNull(document.archivedAt),
      gt(document.pageCount, 0),
    ));
  let inserted = 0;
  for (const current of documents) {
    const result = await scheduleDocumentMetadata(current.id);
    if (result?.inserted) inserted += 1;
  }
  return inserted;
}
