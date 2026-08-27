# M2 Spec · 06 事后纠正:软删除 / 归人纠正 / 文档拆分 / 分片续传

四项共享同一语义:**修改已归档的文档,而 L1 原件字节永不改动。** 纠正一律以**追加**表达,不以覆盖表达。

## 1. 软删除(M1 审核 #002 S1 移交)

1. `document.archived_at timestamptz` 新列。软删除 **禁止**删除任何 S3 对象。
2. `PATCH /api/v1/documents/:id` body `{ archived: true, reason: string, client_operation_id: uuid }`。
   **幂等键必填**(审核 #004 B-6):弱网重发会写出第二条 journal 与 audit 行,而这些是**只增不改**的 L1 对象 ——
   治理锁下删不掉,D9 单人导出与月度对账里永久留着一条幽灵记录。
3. 软删除后:
   - `GET /documents` **必须**默认过滤掉 `archived_at IS NOT NULL` 的行;`?include_archived=true` 才返回。
   - 直访 `GET /documents/:id` **必须**仍可读(死档不复活,但也不消失 —— 与 M0 A11 的 person 归档同构)。
   - 派生物端点 **必须**仍可用(L2 不受影响)。
4. **必须**双写 journal 事件 `document_archive`,并**必须**写 `_index/audit/{YYYY-MM}.jsonl` 的删除审计行(D11 的文档删除部分,M1 时移交至此)。
5. 撤销归档(`{ archived: false }`)**必须**同样双写 journal。

## 2. 归人纠正(D15,ADR-041 §4)

1. 接口:`POST /api/v1/documents/:id/reassign` body `{ to_person_id, reason, client_operation_id }`。**幂等键必填**,理由同 §1.2。
2. **S3 侧表达为追加,不是移动**:
   - **禁止**改动或复制已落桶的原件、`capture.json`、`page-NN.json`。它们在旧 person 的前缀下**原样保留**。
   - **必须**在原文档目录写 `correction-{NNNN}.json`(`NNNN` 从 0001 起,零填充四位,`If-None-Match: *` 仅创建),内容为 `CorrectionSidecar`(contracts 已有,`kind='person_reassign'`,含 `from_person_slug`/`to_person_slug`/`reason`/`seq`)。
   - **必须**在 `_index/manifests/{YYYY}-{MM}.jsonl` 追加一条修正行(ADR-041 §4:同 `doc_short_id` 后写覆盖先写)。
3. `rebuild-index` **必须**按"最后写入者胜"重放:同 `doc_short_id` 的多条 manifest 行按 `created_at` 排序,末条决定 `person_id`。
   > 没有这条,重建会让纠正前的错误归属复活 —— ADR-041 的背景里正是这个缺陷。
4. **必须**双写 journal 事件 `person_reassign`。
5. 纠正后 **必须**把该文档的 `person_check` 置 `skipped`(人已经做过判断,不要再报同一个警)。
6. **禁止**级联移动派生物:`derived/{old_slug}/...` 保留原样并**必须**在下次访问时按新 slug 重生。派生物可丢,这正是 L2 的意义。
7. **必须**把 `document.s1_artifact_key` 置 null —— 强制 S1 工件按新前缀重生([03](./03-stage1.md) §4:`{slug}` 恒取权威归属 slug)。
8. **★ 任何改变 `document_page.page_no` 的操作(split / merge / move-page)必须删除受影响文档 `derived/{slug}/{short_id}/` 前缀下的全部派生物**(审核 #004 B-7)。
   > 派生物 key 的 `NN` 就是 `page_no`。移页后源文档重排:原第 3 页变成第 2 页,而 `preview-02.webp` **已经存在**(内容是被移走的那一页)⇒
   > 缓存命中 ⇒ **静默显示错误的页**。对一个病历系统,"看到别人的那一页"是最不能接受的一类错误,而且它不报错。
   > 这与 D19(孤儿派生物残留)**不是同一个问题** —— D19 说的是留着没人清,这里说的是**错配**。

## 3. 文档边界组装(D7)

三个接口,均 **必须**经 `defineRoute` 并双写 journal:

| 接口 | 语义 |
|---|---|
| `POST /documents/:id/split` body `{ at_page_no }` | 从第 `at_page_no` 页起拆为新文档 |
| `POST /documents/:id/merge` body `{ absorb_document_id }` | 把另一文档的页并入本文档尾部 |
| `POST /documents/:id/move-page` body `{ page_no, to_document_id }` | 单页移动 |

1. 与归人纠正同理:**S3 原件不动**。页的归属变更以 `correction-{NNNN}.json` 记录。
   **`merge` 与 `move-page` 禁止写 manifests**(审核 #004 B-5)——`ManifestLine` 是 `.strict()` 判别联合、只有 `add | person_correct`,
   新增 op 要同步 contracts + `_meta` 两处 + rebuild,而这代价换不来任何东西:回放已能从 correction 得到全部页归属信息。
   **只有 `split` 写 manifests**(一条 `ManifestAdd`,`origin='split'`),因为新文档需要 add 行才能被建出骨架。

   **重建故事(审核 #003 A4 —— 没有这条,D7 就是"能用但重建后消失"的功能):**

   a. `CorrectionSidecar.kind` 扩展为 `person_reassign | page_move`。拆分与合并**均分解为一组 `page_move`**,不另立类型。
   b. `page_move` 载荷 **必须**含 `{ seq, from_doc_short_id, to_doc_short_id, page_sha256, from_page_no, to_page_no }`。
      > **用 `page_sha256` 而非 key 定位页**:key 里的 `NN` 是拍摄序且永不改名(ADR-047),移页之后 key 与所属文档不再对应,只有内容摘要是稳定锚点。
   c. **`split` 产生的新文档必须写自己的 `capture.json`**(审核 #004 A-4 / A-12′)。
      > 原版说"新文档没有自己的 `capture.json`,`person_id` 由 add 行提供" —— 但那只解决了一个字段。
      > `document` 的 NOT NULL 列里,`id`/`source`/`captured_at`/`capture_date`/`uploaded_by`/`client_document_id` **六项**
      > 在 `ManifestAdd`(仅 7 个字段、`.strict()`)与 `page_move` 载荷里都没有;而 `rebuild-index` 现行逻辑对取不到
      > `capture.json` 的目录直接记幽灵行并 `continue` ⇒ 新文档**根本不入库**,A21b 不可能通过。
      > 写 `capture.json` 还保住了 `docs/04 §8` 既有的不变式「每个文档目录必有 capture.json」。

      新 `capture.json` 的取值**必须**是:`source='split'`;`pages` **以完整 key 引用源目录原件**(不复制字节);
      `client_document_id` 由 `client_operation_id` 确定性派生(可重放);`captured_at`/`capture_date` = **源文档的值**。
   c2. 新文档的 **`prefix` 使用新 `short_id`**,`capture_date` = 源文档的 `capture_date`。
      该目录只新增 `capture.json`,不复制 `page-*` 原件或 page sidecar。原件仍由 `pages[].file`
      指向其既有完整 key。由此产生一条与 ADR-047 同构的分离,**必须**写进 spec:
      > **新文档的 manifest/capture/derived 前缀用新 `short_id`,但其原件 key 可含源 `short_id`;
      > `parseKey`、月度对账与运行时代码不得从原件 key 推断当前文档归属。**
      > 审核 #004 A-12′ 曾写“新文档 prefix = 源目录”，这与同一裁决要求的“新文档自己写
      > `capture.json`”在 WORM key 唯一条件下不可同时成立；本条是实现期的可执行修正。
   d. `rebuild-index` 的重放顺序 **必须**是:①按 manifests 建文档骨架 → ②读各目录 `capture.json` 恢复页 → ③人工层回放([07](./07-replay.md))→ ④**扫描全部 `correction-*.json`,按 `(corrected_at, from_doc_short_id, seq)` 全局排序后重放 `page_move`**。
      > 排序键修正见 [01](./01-contracts-delta.md) §6.3:该 schema 的时间字段叫 `corrected_at` 不叫 `created_at`,且 `seq` 是目录内计数器、跨目录做次键无意义(审核 #004 B-4)。
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
5. **`complete` 之后必须由服务端 GET 回流并重算整文件 sha256**,与客户端申报值比对,再走 Head-then-Copy(审核 #004 A-9 / B-4)。
   > **禁止**沿用既有的 `HeadObject(ChecksumMode).ChecksumSHA256` 比对:分片对象的该值是**各分片校验和的复合值**(带 `-N` 后缀),
   > 与整文件 sha256 **永不相等** ⇒ 第一个 12 MiB 文件在 `complete` 后就 100% 抛 `sha256_mismatch`。
   > 而且 `sign` 载荷 `{upload_id, part_numbers[]}` **不携带任何 per-part checksum**、`complete` 载荷只有 `{part_number, etag}` ——
   > 即便想做复合校验也缺输入。
   > 50 MiB 上限下回流重算的代价可接受,且这条顺手把 ADR-048 为 R2 选定的方案(服务端重算 sha256)提前落地了。

## 5. 共同约束

1. 以上四类操作 **全部是人的判断** ⇒ **全部双写 journal**,无例外。
2. 以上四类操作 **全部禁止**修改任何已落桶 L1 对象的字节。
3. 每类操作 **必须**在 [99](./99-acceptance.md) 有一条"操作后 L1 既有对象逐字节不变"的断言 —— 四类**无一例外**(审核 #004 B-11:原版只有归人纠正与拆分有)。
4. **`correction-NNNN.json` 写入遇 412 时,必须重新 LIST 该目录、取 `max(seq)+1` 重试(≤3 次);禁止把 412 当作幂等成功**(审核 #004 C-5)。
   > `putWorm` 现行把 412 映射为 `'exists'`。归人纠正与移页几乎同时提交时两侧都算出 `seq=1`,第二个拿 412 ——
   > 若当成幂等命中,这次纠正就被**静默丢弃**了。幂等由 `client_operation_id` 承担,**不由 `seq` 承担**。
