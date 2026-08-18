import { z } from 'zod';
import { Uuid, IsoDateTime } from './scalars.js';
import { PersonSidecar } from './person.js';

// spec m0-01 §5:M0 只有 person_update。后续里程碑向 union 追加;
// 禁止修改已有事件 schema(只能加新 schema_version)。
export const JournalPersonUpdate = z
  .object({
    schema_version: z.literal('1.0'),
    event: z.literal('person_update'),
    event_id: Uuid, // uuid v7,回放幂等键
    at: IsoDateTime,
    by_account_id: Uuid,
    person: PersonSidecar,
  })
  .strict();

// M1:曾拍摄但放弃 —— 无法从任何原件重建的人工层事实(m1-01 §B4)
export const JournalCaptureDiscard = z
  .object({
    schema_version: z.literal('1.0'),
    event: z.literal('capture_discard'),
    event_id: Uuid,                 // = 请求的 discard_event_id
    at: IsoDateTime,
    by_account_id: Uuid,
    client_document_id: z.string().min(8).max(64),
    person_slug: z.string(),
    captured_at: IsoDateTime,
    page_count: z.number().int().min(1),
    reason: z.enum(['user_discarded', 'terminal_error']),
    detail: z.string().max(500).nullable(),
  })
  .strict();

export const JournalEvent = z.discriminatedUnion('event', [
  JournalPersonUpdate, JournalCaptureDiscard,
]);

// 事件注册表(_meta/registries 与 README 的内容来源)
export const JOURNAL_EVENT_REGISTRY = ['person_update', 'capture_discard'] as const;

// ── 系统级审计(D11,m1-02 §5)——与 journal 分开:它记的是权限,不是人工判断 ──
export const AuditAccessGrant = z
  .object({
    schema_version: z.literal('1.0'),
    event_id: Uuid,
    op: z.enum(['access_grant', 'access_revoke']),
    account_id: Uuid,
    person_id: Uuid,
    person_slug: z.string(),
    role: z.enum(['owner', 'editor', 'viewer']),
    at: IsoDateTime,
  })
  .strict();
export const AuditLine = z.discriminatedUnion('op', [AuditAccessGrant]);
