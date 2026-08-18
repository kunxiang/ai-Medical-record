# M1 Spec · 01 contracts 增量

只列**新增/修改**;M0 既有 schema 不动(改动等同契约变更,须记 CHANGES)。

## 1. 文档列表(07 §3 的 M1 子集)

```ts
export const DocumentListQuery = z.object({
  person_id: Uuid,                              // 必填(07)
  from: IsoDate.optional(),                     // 按 capture_date(M1 无 AI 日期)
  to:   IsoDate.optional(),
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
// [偏差:vs 07 §3 —— doc_type / facility_id / department / date_field / status 五个筛选参数
//  M1 不实现:它们的值全部来自 AI 元数据(M2)或不可达状态。M2 补齐。]

export const DocumentListItem = z.object({
  id: Uuid, short_id: DocShortId, person_id: Uuid,
  capture_date: IsoDate, captured_at: IsoDateTime,
  page_count: z.number().int(), doc_type: DocType, status: DocumentStatus,
  original_filename: z.string().nullable(),
  first_page: z.object({ page_no: z.number().int(), mime_type: MimeType }).nullable(),
});
export const DocumentListResponse = z.object({
  documents: z.array(DocumentListItem),
  next_cursor: z.string().nullable(),
});
```

**游标语义**:不透明字符串,内容为 `base64url(captured_at_iso + '|' + document_id)`;排序键固定 `(captured_at DESC, id DESC)`,严格小于游标者为下一页。客户端**禁止**解析游标。

## 2. 缩略图与预览图

```ts
export const DerivativeKind = z.enum(['thumb', 'preview']);
export const DerivativeUrlResponse = z.object({
  url: z.string().url(),
  expires_at: IsoDateTime,
  kind: DerivativeKind,
  generated: z.boolean(),   // 本次请求是否触发了生成(惰性生成,见 03)
});
```

## 3. 软删除

```ts
export const DocumentDeleteResponse = z.object({ archived: z.literal(true) });
```
文档软删除只置 `document.archived_at`,**S3 原件不删**(07 §3)。需要新增 DB 列(见 [02](./02-api-delta.md) §4)。

## 4. journal 新增事件(注册表追加,禁止改已有事件)

M1 引入两类不可再生的人工输入:**文档软删除**(人的判断)与**队列项的人工放弃**(见 [04](./04-offline-queue.md) §6)。

```ts
export const JournalDocumentArchive = z.object({
  schema_version: z.literal('1.0'),
  event: z.literal('document_archive'),
  event_id: Uuid, at: IsoDateTime, by_account_id: Uuid,
  doc_short_id: DocShortId,
  reason: z.string().max(500).nullable(),
}).strict();

export const JournalCaptureDiscard = z.object({
  schema_version: z.literal('1.0'),
  event: z.literal('capture_discard'),
  event_id: Uuid, at: IsoDateTime, by_account_id: Uuid,
  client_document_id: z.string().min(8).max(64),
  person_slug: PersonSlug,
  captured_at: IsoDateTime,
  page_count: z.number().int().min(1),
  reason: z.enum(['user_discarded', 'terminal_error']),
  detail: z.string().max(500).nullable(),
}).strict();

export const JournalEvent = z.discriminatedUnion('event', [
  JournalPersonUpdate, JournalDocumentArchive, JournalCaptureDiscard,   // ← 追加,不改已有
]);
export const JOURNAL_EVENT_REGISTRY = ['person_update', 'document_archive', 'capture_discard'] as const;
```

> **`capture_discard` 为什么必须落 L1**:用户在医院拍了一张、又主动放弃(或上传永久失败),这个"曾经存在过一次拍摄"的事实无法从任何原件重建。不记录它,五年后翻档案时无法解释"那次就诊为什么没有化验单"。它是人工层事件,与 D1 同源。**放弃时原件已在本地被删,故 journal 只记事实、不记内容。**

## 5. 硬约束

1. 新事件必须在同一提交内加进 `_meta/schemas/1.0/journal.json`(D10/B8 会强制)。
2. `DocumentStatus` 枚举不变;M1 仍只写 `ready`。
3. 客户端与服务端共用同一份 contracts;PWA **禁止**内联定义任何请求/响应形状。
