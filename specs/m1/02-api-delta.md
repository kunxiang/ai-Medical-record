# M1 Spec · 02 API 增量(审核 #002 修订版)

M0 既有路由行为不变(软删除已移交 M2,不再触碰 `requireDocumentAccess`)。新增全部经 `defineRoute`。

```
GET    /api/v1/documents                       requirePersonAccess(viewer, query.person_id)
GET    /api/v1/documents/:id/pages/:n/thumb    requireDocumentAccess(viewer)   → 302
GET    /api/v1/documents/:id/pages/:n/preview  requireDocumentAccess(viewer)   → 302
POST   /api/v1/captures/discard                requirePersonAccess(editor, body.person_id)
GET    /api/v1/people/:id/identifiers          requirePersonAccess(viewer)     ← M0 欠账(审核 #001 B-8)
```
`[偏差:vs 07 §2/§3 —— 新增 /captures/discard 资源族;须回写 07。]`

## 1. `GET /documents`

入参 `DocumentListQuery`,出参 `DocumentListResponse`;排序与游标见 [01](./01-contracts-delta.md) §B1。

- 需索引:`(person_id, captured_at DESC, id DESC)`。M0 既有 `idx_document_person_captured` 不含 `id` → **迁移 0001 替换**(同步改 `schema.ts`,否则 drizzle-kit 漂移;审核 #002 B 档)。
- **不做** `archived_at` 过滤(该列随软删除移交 M2,M1 不存在)。
- `first_page` 取 `page_no = 1`;缺失返回 null 不报错。

`GET /people` 的分页:M0 标注"M1 补"。**裁决:仍不分页**,改绑 M4(检索里程碑统一处理列表分页)。`[偏差:vs m0-01 §4 的"M1 补";理由:个人档案人数恒为个位数,分页无收益。须回写 m0-01。]`

## 2. 派生物(302)

1. 查 `document_page`,不存在 → 404。
2. mime = `application/pdf` → **415 `derivative_unavailable`**(D13)。
3. HeadObject 派生 key:存在 → 302 到预签名 GET(300s),`X-Amr-Generated: 0`。
4. 不存在 → 同步生成([03](./03-derivatives.md))→ 写 `derived/`(**不上锁**)→ 302,`X-Amr-Generated: 1`。
5. 生成失败 → **422 `derivative_generation_failed`**,记 `storage_key` 与 sha256;**禁止**降级返回原图 URL。

**★ 不写 `document_page.thumb_key`**(审核 #002 A-2):判定以 HeadObject 为准,该列写了也不读,只会把 L2 缓存混进 L1 重建等价性。立规:**凡值只能由 L2 生成的 DB 列,一律排除于重建等价性之外;新增此类列必须同时登记排除表。**

并发:同 key 重复生成允许(幂等覆盖);`sharp.concurrency(1)` 在**进程启动时**设置一次(非请求内)。

## 3. `POST /captures/discard`

`CaptureDiscardRequest` → `CaptureDiscardResponse`。事务内:person 粒度 advisory lock(同 m0/CHANGES #3)→ 追加 journal `capture_discard`(`event_id` = 请求的 `discard_event_id`)→ COMMIT。

**幂等**:客户端持久化 `discard_event_id`,重放写入同一 `event_id` 的行;回放侧按 `event_id` 去重(与 manifest 同机制),**无需**扫描历史 journal 分片。

## 4. rebuild 的事件处理

M1 不引入任何需要回放到 DB 的 journal 事件。`rebuild-index` 需两处改动:

1. **修正文件头注释**(它声称读 journal,实际从不读)—— 改为如实描述:M0/M1 期 journal 无 DB 落点。
2. 遇到已知但无 DB 落点的事件(`capture_discard`)→ 按 `event_id` 记为已回放并**忽略,不进对账报告**;遇到未知事件类型 → 进对账报告(这是"注册表落后于桶"的信号)。

真正的 journal 回放能力登记为 **D16**,绑 M3(问答答案才是第一个必须回放到 DB 的人工层事件)。

## 5. D11 清偿:系统级审计 `_index/audit/`

收窄为**权限授予/撤销**(文档删除随软删除移交 M2)。M0 建档时的 owner 自动授予是 M1 之前唯一的权限变更来源,M1 起补写:

```jsonl
{"schema_version":"1.0","event_id":"<uuidv7>","op":"access_grant","account_id":"…","person_id":"…","person_slug":"…","role":"owner","at":"…"}
```
key:`_index/audit/{YYYY-MM}.jsonl`(04 §1 矩阵已有该行:L1 · 只追加 · ✅ 上锁 · 必带)。写入用 `appendJsonl` + advisory lock,与 journal 同纪律。建档事务的五步扩为六步(第 3.5 步)。

> D11 的 `revoke` 分支在 M1 无触发路径(无撤销 API),但写入函数必须支持,M8 多用户时直接接上。design-debt D11 行更新为"文档删除部分移交 M2"。

## 6. D12 清偿:token 吊销

```sql
ALTER TABLE account ADD COLUMN token_epoch int NOT NULL DEFAULT 0;
```
- JWT claims 增 `ep`(签发时的 `token_epoch`);校验时读库比对,不等即 401。
- `seed-account` 更新密码时 `token_epoch = token_epoch + 1` → 旧 token 立即失效。
- argon2 参数版本:`password_hash` 字符串自带参数(`$argon2id$v=19$m=65536,t=3,p=4$…`),登录时若参数与当前常量不符 → **验证通过后用新参数重算并更新**(渐进迁移,无需停机)。

验收:改密码后旧 token 立即 401(99 B 组)。

## 7. ★ CORS(审核 #002 A-5:不修则 M1 第一跳即死)

### 7.1 API 侧

`@fastify/cors`:`origin` 来自 env `WEB_ORIGIN`(逗号分隔白名单,**禁止** `*`);`methods: [GET,POST,PATCH,DELETE,OPTIONS]`;`allowedHeaders: [content-type, authorization]`;`credentials: false`(用 Bearer,不用 cookie);`maxAge: 600`。

### 7.2 S3 桶侧(进 `provision-bucket` 与其自检)

```json
{ "CORSRules": [{
  "AllowedOrigins": ["<WEB_ORIGIN 列表>"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["content-type", "x-amz-checksum-sha256", "x-amz-sdk-checksum-algorithm", "x-amz-content-sha256", "x-amz-date"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 600
}] }
```
带 `x-amz-checksum-sha256` 的跨源 PUT **必然触发 preflight**,`AllowedHeaders` 漏一个就是整条链死。`provision-bucket` 自检增 `get-bucket-cors` 与期望 JSON 逐字段比对。
`[偏差:vs m0-04 §1 "CORS | M0 无浏览器端:空配置 | M1 采集端上线时补" —— 此处兑现,落 m0/CHANGES #8。]`

## 8. 数据库迁移 0001

```sql
ALTER TABLE account ADD COLUMN token_epoch int NOT NULL DEFAULT 0;
DROP INDEX idx_document_person_captured;
CREATE INDEX idx_document_person_captured ON document (person_id, captured_at DESC, id DESC);
```
无 `archived_at`(软删除移交 M2)。必须同步 `apps/api/src/db/schema.ts`,CI 断言从零重放通过。
