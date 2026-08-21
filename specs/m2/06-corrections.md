# M2 Spec · 06 事后纠正:软删除 / 归人纠正 / 文档拆分 / 分片续传

四项共享同一语义:**修改已归档的文档,而 L1 原件字节永不改动。** 纠正一律以**追加**表达,不以覆盖表达。

## 1. 软删除(M1 审核 #002 S1 移交)

1. `document.archived_at timestamptz` 新列。软删除 **禁止**删除任何 S3 对象。
2. `PATCH /api/v1/documents/:id` body `{ archived: true, reason: string }`。
3. 软删除后:
   - `GET /documents` **必须**默认过滤掉 `archived_at IS NOT NULL` 的行;`?include_archived=true` 才返回。
   - 直访 `GET /documents/:id` **必须**仍可读(死档不复活,但也不消失 —— 与 M0 A11 的 person 归档同构)。
   - 派生物端点 **必须**仍可用(L2 不受影响)。
4. **必须**双写 journal 事件 `document_archive`,并**必须**写 `_index/audit/{YYYY-MM}.jsonl` 的删除审计行(D11 的文档删除部分,M1 时移交至此)。
5. 撤销归档(`{ archived: false }`)**必须**同样双写 journal。

## 2. 归人纠正(D15,ADR-041 §4)

1. 接口:`POST /api/v1/documents/:id/reassign` body `{ to_person_id, reason }`。
2. **S3 侧表达为追加,不是移动**:
   - **禁止**改动或复制已落桶的原件、`capture.json`、`page-NN.json`。它们在旧 person 的前缀下**原样保留**。
   - **必须**在原文档目录写 `correction-{NNNN}.json`(`NNNN` 从 0001 起,零填充四位,`If-None-Match: *` 仅创建),内容为 `CorrectionSidecar`(contracts 已有,`kind='person_reassign'`,含 `from_person_slug`/`to_person_slug`/`reason`/`seq`)。
   - **必须**在 `_index/manifests/{YYYY}-{MM}.jsonl` 追加一条修正行(ADR-041 §4:同 `doc_short_id` 后写覆盖先写)。
3. `rebuild-index` **必须**按"最后写入者胜"重放:同 `doc_short_id` 的多条 manifest 行按 `created_at` 排序,末条决定 `person_id`。
   > 没有这条,重建会让纠正前的错误归属复活 —— ADR-041 的背景里正是这个缺陷。
4. **必须**双写 journal 事件 `person_reassign`。
5. 纠正后 **必须**把该文档的 `person_check` 置 `skipped`(人已经做过判断,不要再报同一个警)。
6. **禁止**级联移动派生物:`derived/{old_slug}/...` 保留原样并**必须**在下次访问时按新 slug 重生。派生物可丢,这正是 L2 的意义。

## 3. 文档边界组装(D7)

三个接口,均 **必须**经 `defineRoute` 并双写 journal:

| 接口 | 语义 |
|---|---|
| `POST /documents/:id/split` body `{ at_page_no }` | 从第 `at_page_no` 页起拆为新文档 |
| `POST /documents/:id/merge` body `{ absorb_document_id }` | 把另一文档的页并入本文档尾部 |
| `POST /documents/:id/move-page` body `{ page_no, to_document_id }` | 单页移动 |

1. 与归人纠正同理:**S3 原件不动**。页的归属变更以 `correction-{NNNN}.json` 记录,并在 manifests 追加。

   **重建故事(审核 #003 A4 —— 没有这条,D7 就是"能用但重建后消失"的功能):**

   a. `CorrectionSidecar.kind` 扩展为 `person_reassign | page_move`。拆分与合并**均分解为一组 `page_move`**,不另立类型。
   b. `page_move` 载荷 **必须**含 `{ seq, from_doc_short_id, to_doc_short_id, page_sha256, from_page_no, to_page_no }`。
      > **用 `page_sha256` 而非 key 定位页**:key 里的 `NN` 是拍摄序且永不改名(ADR-047),移页之后 key 与所属文档不再对应,只有内容摘要是稳定锚点。
   c. `split` **必须**同时向 manifests 追加新文档的 `add` 行 —— 新文档没有自己的 `capture.json`,其 `person_id` 只能由该 `add` 行提供。
   d. `rebuild-index` 的重放顺序 **必须**是:①按 manifests 建文档骨架 → ②读各目录 `capture.json` 恢复页 → ③**扫描全部 `correction-*.json`,按 `(created_at, seq)` 全局排序后重放 `page_move`**。
   e. 重放 `page_move` 时目标文档若不存在,**必须**由 `to_doc_short_id` 触发建档(其归属取自 c 的 `add` 行)。
   f. 验收断言 [99](./99-acceptance.md) A21b:拆分后删库重建 → 拆分结果原样复原。
2. `document_page.page_no` **必须**在目标文档内重排为从 1 起的连续序列;`capture_order` **禁止**改动(ADR-047:它是拍摄瞬间的 L1 事实)。
3. 幂等:三个接口 **必须**接受 `client_operation_id`,重复提交 **必须**返回首次结果(与 m0-06 §3 同构),**禁止**产生第二次拆分。
4. S1 的 `boundary_hint`([03](./03-stage1.md) §1)**只是建议**,**禁止**自动执行拆分。

## 4. 分片 + 断点续传(D14)

1. 三段式接口,均 **必须**经既有鉴权:

| 接口 | 语义 |
|---|---|
| `POST /uploads/multipart/create` | 建立分片上传,返回 `upload_id` + `key` |
| `POST /uploads/multipart/sign` body `{ upload_id, part_numbers[] }` | 批量返回分片预签名 URL |
| `POST /uploads/multipart/complete` body `{ upload_id, parts[] }` | 完成合并 |

2. 触发阈值:单文件 > **8 MiB** **必须**走分片;≤ 8 MiB **必须**走既有单 PUT(不给小文件增加三次往返)。
3. 分片大小 **必须**为 8 MiB(末片可小)。客户端 **必须**把已完成分片的 `{part_number, etag}` 持久化进 IndexedDB,使刷新后可续传。
4. 未完成的分片上传由桶生命周期规则 `AbortIncompleteMultipartUpload`(1 天)清理 —— 该规则已在 M1 provision 中落地。
5. `complete` **必须**沿用既有的 Head-then-Copy 与 sha256 校验路径;**禁止**因为走了分片就跳过校验。

## 5. 共同约束

1. 以上四类操作 **全部是人的判断** ⇒ **全部双写 journal**,无例外。
2. 以上四类操作 **全部禁止**修改任何已落桶 L1 对象的字节。
3. 每类操作 **必须**在 [99](./99-acceptance.md) 有一条"操作后 L1 快照逐字节不变"的断言。
