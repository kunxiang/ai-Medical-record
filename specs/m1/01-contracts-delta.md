# M1 Spec · 01 contracts 增量(审核 #002 修订版)

分两部分:**A. M0 契约修订**(改动已冻结的 M0 spec,逐项落 `specs/m0/CHANGES.md`)与 **B. M1 新增**。

---

# A. M0 契约修订(4 项)

## A1. `DocumentCreate` 增 `confirmed_by`(m0/CHANGES #5)

```ts
confirmed_by: z.enum(['api', 'capture_ui', 'import']).default('api'),
```
服务端原样写入 `capture.json.person.confirmed_by`(该字段在 m0-03 §4 早已定义为三值枚举,但 M0 无 UI 只能写 `api`)。**PWA 一律传 `capture_ui`** —— 这是 ADR-041 核心断言("归属由拍摄现场的人点选")在 L1 的唯一载体,且对象锁 10 年,写错即永久失真。

## A2. `PageIn` 与 `capture.json.pages[]` 增 `capture_order` 与 `exif`(m0/CHANGES #6)

```ts
// PageIn 追加
capture_order: z.number().int().min(1),          // 拍摄顺序(ADR-025/ADR-047)
exif: z.object({
  captured_at: IsoDateTime.nullable(),           // DateTimeOriginal(带 offset;无 offset 按本机时区补)
  orientation: z.number().int().min(1).max(8).nullable(),
}).strict().nullable(),
```

- `capture_order` 是**拍摄瞬间即知的事实**,按 ADR-045 判据本就该在 L1;M2 用页脚解析出语义页序后,`page_no` 可与 key 中的 NN 分离(ADR-047),届时 `capture_order` 是唯一能还原"当时怎么拍的"的凭证。
- `exif` 原样落 `page-NN.json.exif`,勾销 m0-03 §4 的"M1 采集端补"欠账。
- `capture.json.pages[]` 同步增 `capture_order`(WORM 事实)。

## A3. 幂等比对口径修正(m0/CHANGES #4)★ 最重要

**问题**:M0 用 `canonicalJson(DocumentCreate)` 全量字节比对,而 `DocumentCreate` 含 `batch_id`/`upload_id`;M1 规定"每次重试重新 presign"⇒ 任何"服务端已提交但客户端未收到 2xx"的重试都会 payload 不同 → 409 终止 → 用户被告知永久失败,而文档其实已建好。

**修正**:比对**稳定语义子集**,由 contracts 导出唯一实现:

```ts
export function idempotencyFingerprint(input: DocumentCreateT): string {
  return canonicalJson({
    client_document_id: input.client_document_id,
    person_id: input.person_id,
    captured_at: input.captured_at,
    source: input.source,
    confirmed_by: input.confirmed_by,
    pages: [...input.pages]
      .sort((a, b) => a.page_no - b.page_no)
      .map((p) => ({ page_no: p.page_no, sha256: p.sha256,
                     width: p.width, height: p.height, capture_order: p.capture_order })),
  }).toString('utf-8');
}
```
`batch_id`、`upload_id`、`exif` 排除在外(前二者是传输载体,`exif` 由客户端解析、允许版本差异)。服务端存 `idempotencyFingerprint` 而非整包 payload。

## A4. `parseKey` 补 `derived/` 匹配(m0/CHANGES #7)

M0 已有 `buildKey.derivedMeta` 却无对应 `MATCHERS` 项 —— `parseKey` 遇 derived key 直接抛。M1 新增 thumb/preview 构造器时一并补齐三条匹配规则,否则 99 的矩阵覆盖扫描会误报。

---

# B. M1 新增

## B1. 文档列表

```ts
export const DocumentListQuery = z.object({
  person_id: Uuid,
  from: IsoDate.optional(), to: IsoDate.optional(),   // 闭区间,比对 capture_date
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
// [偏差:vs 07 §3 —— doc_type/facility_id/department/date_field/status 五参数 M1 不实现
//  (值来自 AI 元数据或不可达状态);且 from/to 语义由 sampled_on 改为 capture_date。
//  M2 引入 date_field 并把 'capture' 作为合法取值,默认值切换须记 CHANGES。须回写 07。]

export const DocumentListItem = z.object({
  id: Uuid, short_id: DocShortId, person_id: Uuid,
  capture_date: IsoDate, captured_at: IsoDateTime,
  page_count: z.number().int(), doc_type: DocType, status: DocumentStatus,
  original_filename: z.string().nullable(),
  first_page: z.object({ page_no: z.number().int(), mime_type: MimeType }).nullable(),
});
export const DocumentListResponse = z.object({
  documents: z.array(DocumentListItem), next_cursor: z.string().nullable(),
});
```
**游标**:不透明 `base64url(captured_at_iso + '|' + document_id)`;排序键 `(captured_at DESC, id DESC)`,严格小于游标者为下一页。客户端禁止解析。

## B2. 派生物:302 重定向,不返回 JSON

审核 #002 A-9:返回 JSON 会让 `<img loading="lazy">` 在架构上失效。改为:

```
GET /documents/:id/pages/:n/thumb     → 302 Location: <预签名 GET URL>(Cache-Control: private, max-age=240)
GET /documents/:id/pages/:n/preview   → 同上
```
无响应体 schema。生成与否通过响应头 `X-Amr-Generated: 1|0` 暴露(仅供验收断言,非契约)。

## B3. 放弃采集

```ts
export const CaptureDiscardRequest = z.object({
  person_id: Uuid,
  client_document_id: z.string().min(8).max(64),
  discard_event_id: Uuid,          // ★ 客户端持久化,重放天然幂等
  captured_at: IsoDateTime,
  page_count: z.number().int().min(1),
  reason: z.enum(['user_discarded', 'terminal_error']),
  detail: z.string().max(500).nullable(),
});
export const CaptureDiscardResponse = z.object({ recorded: z.literal(true) });
```

## B4. journal 新增(只加一个事件,`document_archive` 随软删除移交 M2)

```ts
export const JournalCaptureDiscard = z.object({
  schema_version: z.literal('1.0'),
  event: z.literal('capture_discard'),
  event_id: Uuid,                  // = 请求里的 discard_event_id(幂等键)
  at: IsoDateTime, by_account_id: Uuid,
  client_document_id: z.string().min(8).max(64),
  person_slug: PersonSlug, captured_at: IsoDateTime,
  page_count: z.number().int().min(1),
  reason: z.enum(['user_discarded', 'terminal_error']),
  detail: z.string().max(500).nullable(),
}).strict();

export const JOURNAL_EVENT_REGISTRY = ['person_update', 'capture_discard'] as const;
```

> **为什么必须落 L1**:用户在医院拍了一张又主动放弃,"曾经存在过一次拍摄"无法从任何原件重建。不记录它,五年后无法解释"那次就诊为什么没有化验单"。
> **回放语义**:该事件无 DB 落点 —— rebuild 按 `event_id` 记为已回放并忽略,**不进对账报告**(见 [02](./02-api-delta.md) §4)。

## B5. 错误码增量

| HTTP | code | 场景 |
|---|---|---|
| 415 | `derivative_unavailable` | 该页类型不支持派生物(M1:PDF) |
| 422 | `derivative_generation_failed` | 解码或缩放失败 |

必须加进 `packages/contracts/src/errors.ts` 的 `ERROR_CODES`(否则 `ApiError` 取不到 status)。
`[偏差:vs 07 §8 —— 07 错误码表无此二者,须回写。]`

## B6. 硬约束

1. 新事件与新 schema 必须**同一提交内**落 `_meta/schemas/`、`_meta/registries/` 与 `_meta/README.md` 三处(D10;docs/04 §3 明写事件注册表在 README 维护)。
2. PWA 禁止内联定义任何请求/响应形状。
3. `apps/web` 只依赖 `@amr/contracts`(CI 断言)。
