# M0 Spec · 06 API(建档 + 最小上传链)

审核 #001 修订(#1/#2/#5/#15/#16/#19)。schema 一律引用 [01-contracts](./01-contracts.md);此处只规定行为。

`[偏差:vs 09 —— 09 的 M0 清单不含上传,但其验收句要求"上传一张图";按验收句取齐,最小上传链与 journal 属 M0(D1:journal 与产生数据的功能同里程碑)。已回写 09。]`

```
POST /api/v1/auth/login
POST /api/v1/people
GET  /api/v1/people                    含 identifiers?否 —— M0 不提供任何 identifiers 读回
GET  /api/v1/people/:id                (显式裁剪,M1 补 GET identifiers;审核 #001 B-8)
PATCH /api/v1/people/:id               editor;JSON Merge Patch(01 §3)
DELETE /api/v1/people/:id              owner;归档 = 一次编辑,走完整五步(见 §1)
POST /api/v1/people/:id/identifiers    editor
DELETE /api/v1/people/:id/identifiers/:iid   editor
POST /api/v1/uploads/presign           editor(对 body.person_id)
POST /api/v1/documents                 editor
GET  /api/v1/documents/:id             requireDocumentAccess(viewer)
GET  /api/v1/documents/:id/pages/:n/url      同上
```

## 1. 建档与改档:五步原子(审核 #001 #16/#19)

`POST /people`、`PATCH /people/:id`、`POST/DELETE identifiers`、**`DELETE /people/:id`(归档)** 全部执行同一序列,单个 DB 事务内:

```
1. DB 写(person / person_identifier / person_access;归档 = 置 archived_at)
2. 重写 S3 `_person.json`(PersonSidecar 全量:含 id、identifiers、archived_at)
3. 重写 S3 `_index/people.json`(全 person 的 slug→姓名映射;归档人保留并带 archived 标记)
4. 追加 journal `person_update`(event_id = uuidv7)
5. COMMIT(S3 步骤 2–4 是 COMMIT 前的最后动作;任一 S3 写失败 → 全部回滚 → 500)
```

"S3 不动"仅指 `people/{slug}/{yyyy}/**` 的原件与事实 sidecar —— 归档**必须**落桶,否则重建复活死档。

## 2. 最小上传链

### ① `POST /uploads/presign`

1. `PresignRequest` 校验(mime 白名单、byte_size ≤ 50 MiB、files ≤ 99)。
2. 生成并**预留** `doc_short_id`:插入 `upload_batch`(UNIQUE 撞则重试 ≤5);逐文件插入 `upload_file`,`incoming_key = _incoming/{batch_id}/{upload_id}`。
3. 逐文件签发 PUT 预签名(15 分钟),签入 `Content-Type` 与 `x-amz-checksum-sha256`(S3 侧强制校验和)。**最终 key 此刻不存在也不可知**(capture_date 在 ③ 才有)。
4. presign 无幂等键(审核 #001 B5,显式接受):重试产生新批次,旧批次由 24h 过期 + `_incoming` lifecycle 7 天兜底回收。

### ② 客户端直传 `PUT <url>`

不过后端;必须原样携带 `headers`。校验和不符由 S3 拒绝(400)。

### ③ `POST /documents` —— 步骤与失败语义

```
0. requirePersonAccess(editor);person_confirmed === true(否则 400)
1. 幂等检查:(uploaded_by, client_document_id) 命中 →
     payload canonical 比对:相同 → 200 返回既有 document;不同 → 409
2. 批次检查:batch 存在且未过期(否则 422 upload_incomplete);
     batch.person_id == body.person_id(否则 400 validation_failed);
     batch.consumed_by_document_id 非空且 ≠ 本幂等文档 → 409 upload_consumed;
     pages[].upload_id ⊆ 该 batch 的 upload_file(否则 400)
3. 逐页 HeadObject(incoming_key):
     缺失 → 若最终 key 已存在且 sha256 一致,视为已搬运(崩溃重试路径,跳到 5);
             否则 422 upload_incomplete
     实测 ContentLength ≠ 登记 byte_size 或 > 50 MiB → 413 file_too_large
     实测 Content-Type ≠ 登记 mime → 422 unsupported_media_type
     实测 ChecksumSHA256 ≠ 登记 sha256 → 409 sha256_mismatch
4. 计算 capture_date(03 §3),Head-then-Copy 到最终 <page-key>(附 GOVERNANCE 锁 10 年);
     Head 显示最终 key 已存在 → sha256 一致视为幂等续跑,不一致 → 500 报警
5. PutObject page-NN.json、capture.json(If-None-Match: * + 锁;
     412 且既有内容 sha256 相同 → 幂等续跑,不同 → 500 报警)
6. DB 事务:INSERT document(status='ready', doc_type='unknown',
     original_filename = 首文件 filename, capture_date)+ document_page × N
     (mime/byte 取 Head 实测值)+ UPDATE upload_batch.consumed_by_document_id
     + advisory lock 下追加 manifests add 行(event_id)→ COMMIT
7. COMMIT 成功后:删除 _incoming 临时对象(审核 #001 #5 —— 删除在最后;
     失败仅记日志,lifecycle 兜底)
8. 响应 DocumentOut
```

孤儿语义:步骤 4–5 已写的 WORM 对象在步骤 6 失败后成为孤儿 —— 记日志,由月度对账(manifests/桶/DB 三向)发现;重试同一 `client_document_id` 会通过幂等续跑路径收养它们。**禁止**自动删除。

### `GET /documents/:id/pages/:n/url`

返回 GET 预签名(5 分钟)`PageUrlResponse`。禁止裸 S3 URL 或长效凭证。

## 3. 幂等与崩溃矩阵(必测,审核 #001 #5)

| 场景 | 结果 |
|---|---|
| 同幂等键同 payload 重放 | 200 同一 document,S3 无新对象 |
| 同幂等键不同 payload | 409 |
| 步骤 4 后崩溃(部分页已搬)→ 原样重试 | Head 幂等续跑,补齐剩余页,最终成功 |
| 步骤 5 后崩溃(capture.json 已写)→ 重试 | 412-相同 → 续跑;成功 |
| 步骤 6 后崩溃(已 COMMIT,未删临时)→ 重试 | 幂等命中 200;临时对象由 7 步失败日志 + lifecycle 回收 |
| 临时对象已过期清理但最终 key 已存在 → 重试 | 步骤 3 缺失分支:sha256 一致 → 续跑成功 |
