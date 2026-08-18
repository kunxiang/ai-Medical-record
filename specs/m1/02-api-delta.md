# M1 Spec · 02 API 增量

M0 既有路由行为**不变**。新增全部经 `defineRoute` 注册,授权走既有两个检查点(m0-05 §3)。

```
GET    /api/v1/documents                       requirePersonAccess(viewer, query.person_id)
DELETE /api/v1/documents/:id                   requireDocumentAccess(owner)
GET    /api/v1/documents/:id/pages/:n/thumb    requireDocumentAccess(viewer)
GET    /api/v1/documents/:id/pages/:n/preview  requireDocumentAccess(viewer)
```

## 1. `GET /documents`

入参 `DocumentListQuery`,出参 `DocumentListResponse`。

- 排序 `(captured_at DESC, id DESC)`;游标语义见 [01](./01-contracts-delta.md) §1。
- **必须**排除 `archived_at IS NOT NULL` 的文档。
- `from`/`to` 闭区间,比对 `capture_date`(date 列,无时区歧义)。
- 需索引:`(person_id, captured_at DESC, id DESC) WHERE archived_at IS NULL`。M0 既有 `idx_document_person_captured` 不含 `id` 与部分条件 → **迁移 0001 替换之**。
- `first_page` 取 `page_no = 1` 的行;缺失(理论上不可能,page_no 连续性在 M0 强制)时返回 null,不报错。

## 2. 缩略图 / 预览图

```
GET /api/v1/documents/:id/pages/:n/thumb     → DerivativeUrlResponse(kind='thumb')
GET /api/v1/documents/:id/pages/:n/preview   → DerivativeUrlResponse(kind='preview')
```

行为(惰性生成,见 [03](./03-derivatives.md)):

1. 查 `document_page`;不存在 → 404。
2. 该页 mime 为 `application/pdf` → **415 `derivative_unavailable`**(M1 不渲染 PDF,见 03 §4)。
3. HeadObject 派生 key;存在 → 直接签发 GET 预签名(300s),`generated: false`。
4. 不存在 → 同步生成(03 §2)→ 写 `derived/`(**不上锁**)→ 签发,`generated: true`。
5. 生成失败(源对象损坏/解码失败)→ **422 `derivative_generation_failed`**,记日志;**禁止**降级为返回原图 URL(会把 3MB 原图当缩略图推给客户端)。

`document_page.thumb_key` 列在 M0 已建:生成成功后写入该列(缓存判定仍以 HeadObject 为准 —— **DB 是缓存,S3 是真相**)。`preview` 无对应列,不落库。

## 3. `DELETE /documents/:id`(软删除)

事务内:置 `archived_at` → 追加 journal `document_archive`(person 粒度 advisory lock 保序,同 m0 CHANGES #3)→ COMMIT。**S3 原件、sidecar、manifest 行一律不动**(07 §3)。

- 软删除后:列表不可见、`GET /documents/:id` 404、缩略图 404。
- **重建演练不受影响**:manifest 里 add 行仍在,但 journal 的 `document_archive` 会在回放时把该文档标记为已归档 —— rebuild 必须实现这条回放(见 [99](./99-acceptance.md) A1-6)。

## 4. 数据库迁移 0001

```sql
ALTER TABLE document ADD COLUMN archived_at timestamptz;

DROP INDEX idx_document_person_captured;
CREATE INDEX idx_document_person_captured
  ON document (person_id, captured_at DESC, id DESC)
  WHERE archived_at IS NULL;
```

`[偏差:vs 03 §3 —— 03 的 document 表无 archived_at;07 §3 明写"软删除",M0 未实现。须回写 03。]`

## 5. 错误码增量

| HTTP | code | 场景 |
|---|---|---|
| 415 | `derivative_unavailable` | 该页类型不支持生成派生物(M1:PDF) |
| 422 | `derivative_generation_failed` | 解码或缩放失败 |
