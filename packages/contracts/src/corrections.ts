import { z } from 'zod';
import { Uuid } from './scalars.js';

// spec m2-06:事后纠正四件套。共同语义:修改已归档的文档,而 L1 原件字节永不改动;
// 纠正一律以**追加**表达,不以覆盖表达。
//
// 四个接口全部要求 client_operation_id(审核 #004 B-6):弱网重发会写出第二条
// correction / manifest / journal,而这些是**只增不改**的 L1 对象 —— 治理锁下删不掉,
// 单人导出与月度对账里会永久留着一条幽灵记录。

export const ArchiveRequest = z.object({
  archived: z.boolean(),
  reason: z.string().min(1).max(500),
  client_operation_id: Uuid,
});
export const ArchiveResponse = z.object({
  document_id: Uuid,
  archived: z.boolean(),
  archived_at: z.string().datetime({ offset: true }).nullable(),
});

export const PersonCheckAckRequest = z.object({
  reason: z.string().min(1).max(500),
  client_operation_id: Uuid,
});
export const PersonCheckAckResponse = z.object({
  document_id: Uuid,
  person_check_ack_at: z.string().datetime({ offset: true }),
});

export const ReassignRequest = z.object({
  to_person_id: Uuid,
  reason: z.string().min(1).max(500),
  client_operation_id: Uuid,
});

export const SplitRequest = z.object({
  at_page_no: z.number().int().min(2),      // 从第 N 页起拆出;N=1 无意义
  client_operation_id: Uuid,
});

export const MergeRequest = z.object({
  absorb_document_id: Uuid,
  client_operation_id: Uuid,
});

export const MovePageRequest = z.object({
  page_no: z.number().int().min(1),
  to_document_id: Uuid,
  client_operation_id: Uuid,
});

export const CorrectionResponse = z.object({
  document_id: Uuid,
  new_document_id: Uuid.nullable(),         // split 才有
  correction_seq: z.number().int().min(1),
});
