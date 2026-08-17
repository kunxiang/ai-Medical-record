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

export const JournalEvent = z.discriminatedUnion('event', [JournalPersonUpdate]);

// 事件注册表(_meta/registries 快照的内容来源)
export const JOURNAL_EVENT_REGISTRY = ['person_update'] as const;
