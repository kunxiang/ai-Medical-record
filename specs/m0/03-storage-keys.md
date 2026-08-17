# M0 Spec · 03 存储:slug、key、sidecar

`packages/storage` 的规范。依据 [04 · 存储布局](../../docs/04-storage-layout.md)(权威矩阵)与 ADR-008/009/041/045。

## 1. Slug 生成

```
字母表 A = "23456789abcdefghjkmnpqrstvwxyz"   (30 字符,去 0/1/i/l/o/u)
person_slug  = "p" || 5 × 均匀随机取自 A      (30^5 = 24,300,000 个)
doc_short_id = "d" || 5 × 均匀随机取自 A
```

- 随机源**必须**是 CSPRNG(`crypto.getRandomValues`),拒绝取模偏差(rejection sampling 或 256-掩码法)。
- 冲突处理:插入撞 UNIQUE → 重新生成重试,最多 5 次,仍撞则 500(24M 空间内 5 连撞≈不可能,视为故障)。
- 生成后**永不更改**(ADR-009)。

## 2. Key 语法(BNF)

```
byte 约束:全部 key 仅含 [a-z0-9._/-],禁止其他字符。

<page-key>     ::= "people/" <pslug> "/" <yyyy> "/" <docdir> "/page-" <nn> "." <ext>
<pagemeta-key> ::= "people/" <pslug> "/" <yyyy> "/" <docdir> "/page-" <nn> ".json"
<capture-key>  ::= "people/" <pslug> "/" <yyyy> "/" <docdir> "/capture.json"
<corr-key>     ::= "people/" <pslug> "/" <yyyy> "/" <docdir> "/correction-" <nnnn> ".json"
<audio-key>    ::= "people/" <pslug> "/" <yyyy> "/" <docdir> "/audio/" <qkey> "." ("m4a"|"json")
<person-key>   ::= "people/" <pslug> "/_person.json"
<journal-key>  ::= "people/" <pslug> "/journal/" <yyyy> "-" <mm> ".jsonl"
<manifest-key> ::= "_index/manifests/" <yyyy> "-" <mm> ".jsonl"

<docdir>  ::= <capture-date> "__" <dslug>          ; 如 2026-08-17__d7k2m9
<capture-date> ::= <yyyy> "-" <mm> "-" <dd>
<pslug>   ::= "p" 5*<a>     <dslug> ::= "d" 5*<a>     <a> ::= [23456789a-hj-km-np-tv-z]
<nn>      ::= 两位零填充页号(01–99)             <nnnn> ::= 四位零填充序号
<ext>     ::= "jpg" | "png" | "webp" | "pdf"       ; 由上传 mime 决定,见 §5
```

`packages/storage` **必须**导出 `buildKey`/`parseKey` 且满足往返性质:`parseKey(buildKey(x)) deep-equals x`(property test ≥ 1000 例)。解析器**禁止**从 key 推断 key 语法之外的语义(如 doc_type)。

## 3. `capture_date` 折算规则

**key 中的日期段 = `captured_at` 折算到上传者 account 的 `timezone` 后取日期。** 折算结果在登记时刻写死进 `document.capture_date` 与 `capture.json.capture_date` —— 此后 account 改时区**不**影响既有 key(key 永不变)。`<yyyy>` 目录段**必须**等于 `capture_date` 的年份。

## 4. Sidecar JSON Schema

所有 sidecar:UTF-8、无 BOM、`schema_version` 必为首个字段、键序稳定(canonical:字典序)、以 `\n` 结尾。canonical 化由 `packages/storage` 统一实现 —— **同一输入必须字节级可重现**(重建演练要比对 sha256)。

### `capture.json`(WORM)

```jsonc
{
  "schema_version": "2.0",
  "document_id": "<uuid>",
  "short_id": "<dslug>",
  "person": { "slug": "<pslug>", "name": "<string>", "confirmed_by": "capture_ui" },
  "captured_at": "<iso datetime with offset>",
  "capture_date": "<yyyy-mm-dd>",
  "source": "camera|album|pdf|screenshot|scan|import",
  "uploaded_by": "<account uuid>",
  "pages": [ { "page_no": 1, "file": "page-01.jpg", "sha256": "<hex64>",
               "bytes": 1, "mime": "image/jpeg", "width": 1, "height": 1 } ],
  "created_at": "<iso datetime>"
}
```

**禁止**出现的键:`doc_type`、`facility`、`summary`、`sampled_on` 及任何 AI 派生字段(ADR-045)。schema 校验采用 `.strict()` —— 未知键即失败。

### `page-NN.json`(WORM)、`_person.json`(重写式)、journal 行、manifest 行

按 04 §3 的示例逐字段落 zod schema(位于 contracts,storage 只做序列化);`_person.json` 必含 `identifiers[]` 全量。manifest 行 M0 仅 `op:"add"`(schema 同 04 §3,`person_correct` 的 schema 定义但无写入路径)。

## 5. 写入规则

1. **上传的 mime 白名单**:`image/jpeg`、`image/png`、`image/webp`、`application/pdf`。其余 400。
2. **WORM 对象**(page 原件、page json、capture.json):PUT 时设 Object Lock `GOVERNANCE` retention = 写入时刻 + 10 年(04 权威矩阵)。**必须**带 `If-None-Match: *` —— 已存在即失败,禁止覆盖。
3. **重写式对象**(`_person.json`、`_index/people.json`):普通 PUT,不上锁,versioning 留历史。
4. **追加型 JSONL**(journal、manifests):读-改-写 + **条件写**:
   - 并发控制主锁:Postgres advisory lock(key = 对象 key 的 hash),写库事务内完成 S3 读-追加-PUT;
   - S3 层防御:PUT 带 `If-Match: <读到的 etag>`(对象已存在时)/ `If-None-Match: *`(首次创建);412 → 整段重试,上限 3 次;
   - 每行是完整 JSON + `\n`,**禁止**改写既有行。
   - journal 追加与 DB 写在同一事务边界内完成;S3 写失败则整个事务回滚(**双写强一致,宁可拒绝服务不可静默丢**)。
5. `derived/**`:M0 无写入路径,`packages/storage` 仅预留 key 构造器。

## 6. 性质测试(必须)

- slug:字母表覆盖、无禁用字符、长度、分布粗检
- key 往返;非法 key 的 parse 必须抛错(模糊测试:随机变造合法 key 一个字节)
- sidecar canonical 序列化:同输入字节级相等;`.strict()` 拒绝未知键
- journal 并发:两个进程同时追加 100 行,最终行数恰为 200(compose 环境集成测试)
