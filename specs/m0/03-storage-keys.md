# M0 Spec · 03 存储:slug、key、sidecar、双写协议

`packages/storage` 的规范。依据 [04 · 存储布局](../../docs/04-storage-layout.md)(权威矩阵)与 ADR-008/009/041/045。审核 #001 修订。

## 1. Slug 生成

```
字母表 A = "23456789abcdefghjkmnpqrstvwxyz"   (30 字符,去 0/1/i/l/o/u)
person_slug  = "p" || 5 × 均匀随机取自 A      (30^5 = 24,300,000 个)
doc_short_id = "d" || 5 × 均匀随机取自 A
```

- 随机源**必须**是 CSPRNG(`crypto.getRandomValues`),拒绝取模偏差(rejection sampling)。
- 冲突处理:**预留即查重** —— `person.slug` 在建档事务内撞 UNIQUE 重试(≤5 次);`doc_short_id` 在 presign 时插入 `upload_batch.doc_short_id UNIQUE` 撞则重试(≤5 次)。**③ 阶段禁止再生成 short_id**(WORM key 已烧定,重生成 = 制造孤儿目录,审核 #001 B-1)。
- 生成后**永不更改**(ADR-009)。

## 2. Key 语法(BNF)

```
byte 约束:全部 key 仅含 [a-z0-9._/-],禁止其他字符。

<page-key>     ::= <docdir-prefix> "/page-" <nn> "." <ext>
<pagemeta-key> ::= <docdir-prefix> "/page-" <nn> ".json"
<capture-key>  ::= <docdir-prefix> "/capture.json"
<corr-key>     ::= <docdir-prefix> "/correction-" <nnnn> ".json"
<audio-key>    ::= <docdir-prefix> "/audio/" <qkey> "." ("m4a"|"json")
<docdir-prefix>::= "people/" <pslug> "/" <yyyy> "/" <capture-date> "__" <dslug>
<person-key>   ::= "people/" <pslug> "/_person.json"
<journal-key>  ::= "people/" <pslug> "/journal/" <yyyy> "-" <mm> ".jsonl"
<manifest-key> ::= "_index/manifests/" <yyyy> "-" <mm> ".jsonl"
<peoplemap-key>::= "_index/people.json"
<incoming-key> ::= "_incoming/" <uuid> "/" <uuid>          ; batch_id / upload_id
<probe-key>    ::= "_probe/" ("startup" | "lock-probe")

<capture-date> ::= <yyyy> "-" <mm> "-" <dd>                ; <yyyy> 目录段必须等于其年份
<pslug> ::= "p" 5*<a>   <dslug> ::= "d" 5*<a>   <a> ::= [23456789a-hj-km-np-tv-z]
<nn>    ::= 两位零填充页号(01–99)                <nnnn> ::= 四位零填充序号
<ext>   ::= "jpg" | "png" | "webp" | "pdf"
<qkey>  ::= 1*32( [a-z0-9_] )                              ; M0 定语法,不实现 audio 构造器
```

`buildKey`/`parseKey` 必须满足往返性质(property test ≥1000 例);解析器禁止从 key 推断语法之外的语义。mime → ext 映射:`image/jpeg→jpg`、`image/png→png`、`image/webp→webp`、`application/pdf→pdf`,精确小写匹配,带参数或变体在入口即被 422 拒绝(01 §2)。

**PDF 语义(审核 #001 #9):1 个 PDF 文件 = 1 个 page 对象**(内部页数不展开);其 `width`/`height` = 首页 MediaBox 取整 pt(≥1)。

## 3. `capture_date` 折算规则

**key 中的日期段 = `captured_at` 折算到上传者 account 的 `timezone` 后取日期**,于 ③ 登记时刻计算并同时写死进 `document.capture_date` 与 `capture.json.capture_date` —— 此后 account 改时区不影响既有 key。

> 已知权衡(审核 #001 C 档,记录在案):未来多账号且时区不同时,同一 person 的文档可能因上传者不同落入不同日期目录。key 永不变 —— **禁止**未来把这当 bug"修"。

## 4. Sidecar 与行式 JSON 规范

canonical 规则(审核 #001 #8 钉死):**`schema_version` 置首,其余键(含嵌套对象,递归)按字典序**;UTF-8 无 BOM;文件以 `\n` 结尾;JSONL 每行一个 canonical JSON + `\n`。canonical 化由 `packages/storage` 唯一实现,同输入字节级可重现(sha256 稳定)。

时间戳(审核 #001 B8):`capture.json.captured_at` 存**客户端原文**(带原始 offset);其余服务端生成的时间戳一律 `YYYY-MM-DDTHH:mm:ss.SSSZ`(UTC,毫秒 3 位)。

### `capture.json`(WORM,schema `.strict()`)

```jsonc
{
  "schema_version": "2.0",
  "document_id": "<uuid>",
  "short_id": "<dslug>",
  "person": { "slug": "<pslug>", "name": "<string>", "confirmed_by": "api|capture_ui|import" },
  "captured_at": "<客户端原文,带 offset>",
  "capture_date": "<yyyy-mm-dd>",
  "source": "camera|album|pdf|screenshot|scan|import",
  "uploaded_by": "<account uuid>",
  "pages": [ { "page_no": 1, "file": "page-01.jpg", "sha256": "<hex64>",
               "bytes": 1, "mime": "image/jpeg", "width": 1, "height": 1 } ],
  "created_at": "<服务端时间戳>"
}
```

- `person.name` = **登记时刻**(③)从 DB 读取的 `display_name` 快照,此后改名永不回写 —— 它与 key 中的 person 段同为"拍摄时刻断言",权威归属 = manifests 回放(docs/04 §2)。
- **禁止**出现的键:`doc_type`、`facility`、`summary`、`sampled_on` 及任何 AI 派生字段(ADR-045)。`.strict()` —— 未知键即校验失败。
- 尚无已产对象,形状即权威;docs/04 §3 示例已回写对齐(审核 #001 #A-10)。

### `page-NN.json`(WORM)

按 docs/04 §3 逐字段;`exif` 字段 M0 **可选缺省**(服务端不解析图像,客户端不传 —— `[偏差:vs 04 §3 示例含 exif;M1 采集端补]`)。`mime`/`bytes` 以 ③ HeadObject **实测值**为准,不抄登记值。

### `correction-NNNN.json`(WORM,M0 定义 schema、无写入路径)

与 docs/04 §2 一致:

```jsonc
{ "schema_version": "1.0", "seq": 1, "kind": "person_reassign",
  "from_person_slug": "<pslug>", "to_person_slug": "<pslug>",
  "reason": "<string>", "corrected_at": "<服务端时间戳>" }
```

### `_person.json`(重写式)= contracts `PersonSidecar`

**含 `id`(uuid)与 `identifiers[]` 全量与 `archived_at`**(审核 #001 #6/#7:id 随快照走,重建后 person.id 稳定,document 的 FK 不漂移;归档状态必须在桶里)。

### journal 行 = contracts `JournalEvent`;manifest 行

manifest `add` 行增加 `event_id`(uuid v7):

```jsonl
{"schema_version":"1.0","event_id":"<uuidv7>","op":"add","doc_short_id":"d7k2m9","person_slug":"p3f7a2","prefix":"people/p3f7a2/2026/2026-08-17__d7k2m9/","created_at":"<ts>"}
```

分片规则(审核 #001 B3):journal/manifest 的月份分片取**事件 `at`/`created_at` 的 UTC 年月**。

## 5. 写入规则

1. **WORM 对象**(page 原件、page json、capture.json、correction):服务端 `PutObject`,带 Object Lock `GOVERNANCE` retention = 写入时刻 + 10 年,并带 `If-None-Match: *`(PutObject 支持条件写)—— 已存在即 412。**注意:S3 的"不可覆盖"只是本条纪律 + 版本锁,versioning 桶上裸 PUT 仍会产生新版本**(见 04 §4 的真实语义)。
2. **`_incoming/**` 直传对象**:预签名 PUT 直传,签入 `Content-Type` 与 `x-amz-checksum-sha256`(S3 侧强制校验和);**不上锁**(最终 key 未知 + 校验前不上锁,审核 #001 #15)。搬运用 **Head-then-Copy**(先 Head 最终 key 确认不存在,再 CopyObject 附锁参数;CopyObject 无目标端条件写,竞态由 `document_page.storage_key UNIQUE` 与幂等键兜底,审核 #001 #2)。
3. **重写式对象**(`_person.json`、`_index/people.json`):普通 PUT,不上锁,versioning 留历史。
4. **追加型 JSONL**(journal、manifests):
   - 并发控制:`pg_advisory_xact_lock(hashtextextended(<对象 key>, 0))`(事务级,审核 #001 B2);
   - S3 层防御:PUT 带 `If-Match: <etag>` / 首次 `If-None-Match: *`;412 → 重读重试 ≤3 次;
   - **写序(审核 #001 #14)**:全部 DB 语句 → S3 追加(事务内最后动作)→ 立即 COMMIT。S3 成功而 COMMIT 失败的窗口**存在且不可消除**(该版本已上锁):产物是"幽灵行"。因此:
   - **回放幂等**:重建按 `event_id` 去重、同 `doc_short_id` 的重复 `add` 幂等合并;`add` 行若无对应 `capture.json` 佐证 → **不建行,进对账报告**(人工处置)。"宁可拒绝服务不可静默丢"防丢行,幂等回放防多行。
5. `derived/**`:M0 无写入路径,仅预留 key 构造器。

## 6. 性质测试(必须)

- slug:字母表覆盖、无禁用字符、长度、分布粗检;预留-冲突-重试路径单测
- key 往返 ≥1000 例;非法 key 的 parse 必须抛错(随机变造一个字节的模糊测试)
- canonical:同输入字节级相等;`schema_version` 居首 + 递归字典序;`.strict()` 拒绝未知键
- journal 并发:两个**应用写路径**进程(走 advisory lock)同时追加 100 行 → 恰 200 行
- 回放幂等:注入重复 event_id 行与无佐证 add 行 → 重建结果不含幽灵、对账报告含记录
