# M0 Spec · 06 API(建档 + 最小上传链)

M0 实现的路由全集。请求/响应 schema 一律引用 [01-contracts](./01-contracts.md);此处只规定行为语义。

```
POST /api/v1/auth/login
POST /api/v1/people                    editor 语义见 05 §3.5
GET  /api/v1/people                    列出我有 person_access 的、未归档的
GET  /api/v1/people/:id
PATCH /api/v1/people/:id               editor
DELETE /api/v1/people/:id              owner;置 archived_at,S3 不动
POST /api/v1/people/:id/identifiers    editor
DELETE /api/v1/people/:id/identifiers/:iid   editor
POST /api/v1/uploads/presign           editor(对 body.person_id)
POST /api/v1/documents                 editor
GET  /api/v1/documents/:id
GET  /api/v1/documents/:id/pages/:n/url
```

## 1. 建档 `POST /people`

事务内原子完成(05 §3.5):person 行(slug 生成见 03 §1)+ `person_access(owner)` + S3 `_person.json` + journal `person_update`。S3 任一写失败 → 整体回滚 → 500。响应含 `slug`。

`PATCH /people/:id`、`POST/DELETE identifiers`:同样四步(重写 `_person.json` 全量快照 + journal 追加)。

## 2. 最小上传链(严格三步,07 §2)

### ① `POST /uploads/presign`

- 入参每文件:`filename、mime_type、byte_size、sha256` + 顶层 `person_id`。
- mime 白名单校验(03 §5.1);`byte_size` ≤ 50 MiB,超出 400。
- 服务端此刻即定 `doc_short_id` 与最终 key(`upload_id` ↔ key 映射存 DB 临时表 `upload`,含 person_id/期望 sha256/mime,TTL 24h)。
- 返回逐文件:`upload_id`、`url`(PUT 预签名,15 分钟)、`headers`(必须原样带上,含 `Content-Type`;预签名策略绑定 content-length-range)。
- **同一批 `files[]` 属于同一个未来 document**;页序由 ③ 的 `page_no` 定,不由本步。

### ② 客户端直传 `PUT <url>`

不过后端。预签名 PUT **不能**带 Object Lock 参数 —— 锁由 ③ 服务端补设(见下)。

### ③ `POST /documents`

顺序执行,任何一步失败按序回滚(S3 侧 WORM 对象不可删 —— 见"失败遗留"):

1. 校验 `person_confirmed === true`(否则 400)、person_access ≥ editor、幂等键查重(命中且 payload 相同 → 200 返回既有 document;命中但不同 → 409)。
2. 对每页 `HeadObject` 校验:对象存在(否则 422 `upload_incomplete`)、sha256 匹配登记值(否则 409 `sha256_mismatch`;S3 直传开启 `x-amz-checksum-sha256`,以 S3 校验和为准)。
3. 计算 `capture_date`(03 §3),将直传的临时对象 **server-side copy** 到最终 `<page-key>`(带 `If-None-Match: *` + GOVERNANCE 锁 10 年),删临时对象。
   > 直传落临时前缀 `_incoming/{upload_id}`,**不落最终 key** —— 因为预签名 PUT 无法附带锁参数,而最终 key 必须"落地即锁"。`_incoming/` 不上锁、生命周期 7 天自动清理、不在权威矩阵的打包范围内。**[偏差:vs 04 §2 —— 04 未写 `_incoming/`;须回写 04 的 key 布局与矩阵]**
4. 写 `page-NN.json`、`capture.json`(WORM + 锁)。
5. DB 事务:插 `document`(status=`ready`;M0 无中间态使用场景,`uploading/uploaded` 建出不用)+ `document_page` × N + advisory lock 下追加 manifests `add` 行。失败 → 事务回滚;已写入的 WORM 对象成为**孤儿**,记入服务日志,由月度对账(S3↔DB 双向,04 §8)发现并人工处置 —— **禁止**自动删。
6. 响应:`{id, short_id, status, person_id, pages[]}`。

### `GET /documents/:id/pages/:n/url`

返回 GET 预签名(5 分钟)。**禁止**在任何响应中返回裸 S3 URL 或长效凭证。

## 3. 幂等语义(必测矩阵)

| 场景 | 结果 |
|---|---|
| 同 `client_document_id`,同 payload,重放 ③ | 200,同一 document,S3 无新对象 |
| 同 key,payload 不同 | 409 |
| ③ 第 5 步失败后原样重试 | 成功;capture.json 的 `If-None-Match` 撞已存在 → 视为"已写入,继续"(内容比对 sha256 相同则幂等通过,不同则 500 报警) |
