# M2 Spec · 01 contracts 增量(审核 #004 修订版)

单一出处纪律不变:枚举与 schema 只在 `packages/contracts` 定义,`packages/ai`、`apps/api`、`apps/web`、`tools` 一律引用。

> 本文件经审核 #004 重写。原版把三个 M0 已存在的列列为"新增"、新造了一个与既有列撞名的 `event_at`、
> 并把不绑人的归一化决策塞进按人分片的 journal —— 三处都已按裁决改正,见 [review-004.md](./review-004.md)。

## 1. 新增文件

| 文件 | 内容 |
|---|---|
| `src/ai.ts` | `Stage1Page` / `Stage1Out` / `PiiKind` / `S1Artifact` |
| `src/jobs.ts` | `AiJobKind` / `AiJobState` / `AiJobItem` / `AiJobListQuery` / `AiJobListResponse` |
| `src/normalization.ts` | `NormalizationKind` / `NormalizationState` / `NormalizationDecision` / **`DecisionLine`**(落 `_index/decisions/`) |
| `src/corrections.ts` | `ReassignRequest` / `SplitRequest` / `MergeRequest` / `MovePageRequest` / `ArchiveRequest` |

## 2. 新增枚举(必须同步迁移 CHECK,CI 断言 m0-99 B2)

```ts
export const PiiKind = z.enum(['phone','id_card','address','insurance_card','bank_card','other']);
export const AiJobKind = z.enum(['stage1','facility_normalize','encounter_suggest']);
export const AiJobState = z.enum(['pending','running','done','failed','needs_human','unsupported']);
export const NormalizationKind = z.enum(['facility','encounter']);
export const NormalizationState = z.enum(['proposed','confirmed','rejected']);
export const PersonCheck = z.enum(['match','mismatch','unknown']);       // ★ 不再含 skipped,见 §5 注 1
export const GroupingBasis = z.enum(['event_time','capture_date_degraded']);  // ★ 落 encounter,不落 document
```

> **`EventTimeSource` 不在此列。** M0 的 `document.event_time_source` 已经存在,其取值域由 `docs/03 §226` 定义(`collected_at` / 报告时间 / 打印时间…)。M2 **复用**该列与该取值域,**禁止**另造枚举(审核 #004 A-5′)。

## 3. M1 契约的修订

| # | 修订 | 理由 |
|---|---|---|
| 1 | `DocumentListItem` 增 `doc_type`、`doc_type_confidence`、`person_check`、`person_check_ack_at`、`facility_name`(均可空) | UI 需在时间轴直接显示类型与告警条。**告警条件是 `person_check='mismatch' AND person_check_ack_at IS NULL`**,故两列都要下发 |
| 2 | `DocumentListQuery` 增 `person_check?`、`doc_type?`、`facility_id?`、`date_field?`(`capture_date\|sampled_on\|reported_on`,默认 `capture_date`) | 兑现 07 §3 的五个筛选参数;`from/to` 语义由固定 `capture_date` 改为按 `date_field` 选择(m1 偏差 #4 的回写,D15 清偿项之一) |
| 3 | `DocumentOut` 增 `archived_at`(可空) | 软删除 |
| 4 | `CorrectionSidecar` 改为判别联合,`schema_version` 升 **`'1.1'`** | 见 §6 |
| 5 | `ManifestAdd` 增 `origin`(`'capture' \| 'split'`,默认 `'capture'`) | 拆分产生的新文档也要有 add 行,但必须能与采集产生的区分开(审核 #004 A-12′) |

**禁止**修改 `capture.json`(2.0)与 `page-NN.json`(2.0)的 schema 版本语义 —— AI 产出不进 L1。

> **例外且仅此一例**:拆分产生的新文档**必须**写自己的 `capture.json`(§6.2),其 `source='split'`。这不是改 schema,是新增一个合法取值。

## 4. journal 与 decisions:按"绑不绑人"分流(审核 #004 A-2)

`appendJournal(tx, personSlug, …)` 的 `personSlug` 是必填的,而 facility 归一是**全家共享词表**(`docs/04 §1` 矩阵第 7 行、ADR-040),它不属于任何一个 person。硬塞进某个人的 journal 会导致:单人导出时孩子拿到父母档案触发的机构决策,或反过来自己缺词表。

### 4.1 落 per-person journal(绑人的判断)

| 事件 | 何时写 | 载荷要点 |
|---|---|---|
| `person_check_ack` | 人工确认"归人告警可忽略" | `document_short_id`、`from_check`、**`observed_name`**(S1 读出的姓名快照)、**`expected_name`**(当时的 `display_name` 快照)、`reason` |
| `person_reassign` | 归人纠正 | `document_short_id`、`from_person_slug`、`to_person_slug`、`reason`、`correction_seq`、`client_operation_id` |
| `document_archive` | 软删除 / 撤销归档 | `document_short_id`、`archived`(bool)、`reason`、`client_operation_id` |
| `document_split` / `document_merge` / `document_move_page` | 文档边界组装 | `from_doc_short_id`、`to_doc_short_id`、`page_sha256[]`、`client_operation_id` |
| `encounter_confirm` **← 删除,不要这个名字** | — | 归组确认走 `normalization_confirm`(`kind='encounter'`),见 §4.2 |

> `observed_name` / `expected_name` 是审核 #004 C-4:**人工判断的依据必须随判断一起进 L1,不能引用一个可丢层**。否则三年后审计"为什么这份归给孩子的报告上写着家长的名字"时,AI 到底读出了什么名字只存在于 `derived/**`,而那一层按矩阵是"可丢、备份不带、迁移可丢"。这与 `capture.json` 里存 `person.name` 快照是同一个道理。

### 4.2 落 `_index/decisions/{YYYY}-{MM}.jsonl`(不绑人的判断)

| op | 何时写 | 载荷要点 |
|---|---|---|
| `normalization_confirm` | 确认/否决 facility 归一**或** encounter 归组提议 | `kind`(`facility\|encounter`)、`input_fingerprint`、`decision`(`confirmed\|rejected`)、`payload`、`client_operation_id` |

1. 该对象类型**已在** `docs/04 §1` 权威矩阵登记(L1 · 只追加 · 上锁 · 打包必带 · 单人导出按类别过滤),M2 只是第一次真正写它。
2. `kind='encounter'` 的决策虽然涉及具体的人,但它承载的是"这两份单据算不算同一次就诊"这类**判断规则**,与 facility 同属可复用词表 ⇒ 一并落 decisions,不落 journal。
3. 写入方式同 journal:`appendJsonl` 读-改-写 + `If-Match`;`event_id` 由调用方持久化。

### 4.3 事件注册与回放

1. 上述 **6 个** journal 事件 + **1 个** decisions op **必须**加入 `JOURNAL_EVENT_REGISTRY`(decisions 另立 `DECISION_OP_REGISTRY`),并由 `gen-meta` 同步至 `_meta/schemas`、`_meta/registries`、`_meta/README.md` 三处(m1-99 B5 会断言)。
2. **`appendJournal` 禁止覆盖调用方传入的 `event_id`;调用方未传时由服务端生成。** 这是 M1 已修复缺陷的准确表述(原版写"必须由调用方传入客户端持久化的 `event_id`",而这六个都是服务端动作,接口载荷里没有该字段 —— 审核 #004 B-6)。
3. **禁止**为任何 AI 产出新增事件。判据见 [00](./00-scope.md) §4.4。
4. **回放是 M2 的交付物**,不是 M3 的(见 [00](./00-scope.md) §3 与 [07](./07-replay.md))。

## 5. 数据库列(逐行核对 `apps/api/src/db/schema.ts` 后重写)

| 表 | 列 | 类型 | M0/M1 已存在? | 层 | 说明 |
|---|---|---|---|---|---|
| `document` | `doc_type` | `text` | ✅ 已存在(默认 `'unknown'`) | **L2 可重算** | M2 开始写入 |
| `document` | `doc_type_confidence` | **`numeric`** | ✅ 已存在 | **L2 可重算** | **保持 `numeric`,禁止改 `real`**(改类型会让"只加可空列"的迁移变成 `ALTER COLUMN TYPE`) |
| `document` | `sampled_on` / `reported_on` | `date` | ✅ 已存在 | **L2 可重算** | M2 开始写入 |
| `document` | `event_time` / `event_time_source` | `timestamptz` / `text` | ✅ 已存在 | **L2 可重算** | M2 开始写入;取值域按 `docs/03 §226`。**禁止**新造 `event_at` |
| `document` | `department_raw` | `text` | ❌ 新增,可空 | **L2 可重算** | |
| `document` | `person_check` | `text` | ❌ 新增,CHECK ∈ `PersonCheck`,默认 `'unknown'` | **L2 可重算** | 比对结果,每次 S1 重跑都会被覆盖 |
| `document` | `person_check_ack_at` | `timestamptz` | ❌ 新增,可空 | **★ L1 人工层** | 人工 ack 的时刻。**禁止**被任何重算写入或清除 |
| `document` | `archived_at` | `timestamptz` | ❌ 新增,可空 | **★ L1 人工层** | 软删除 |
| `document` | `s1_artifact_key` / `s1_prompt_version` | `text` / `integer` | ❌ 新增,可空 | **L2 可重算** | |
| `encounter` | `grouping_basis` | `text` | ❌ 新增,**可空**,CHECK ∈ `GroupingBasis` | **★ L1 人工层** | 归组确认时写入;`NULL` 表示 M2 之前建的 encounter |
| 新表 | `ai_job` | — | ❌ | **L2 可重算** | 见 [04](./04-jobs.md) §2 |
| 新表 | `normalization_decision` | — | ❌ | `confirmed` 行为 **L1 人工层**(可从 decisions 回放);`proposed` 行为 L2 | 见 [05](./05-reconciliation.md) §2 |

**注 1(审核 #004 A-5):`PersonCheck` 删掉 `skipped`。** 原设计让人工 ack 把 `person_check` 置 `skipped`,而 S1 每次重跑都会重算这一列 —— A27 那条验收步骤本身("删光 derived 与 ai_job → 重跑")就会把 ack 抹掉。报告印家长姓名、被检人是孩子这种**永久不可能匹配**的情形,用户将被迫每次模型升级后重新 ack 全家所有此类文档。
拆开之后:比对写 `person_check`(L2),ack 写 `person_check_ack_at`(L1)。**告警条件 = `person_check='mismatch' AND person_check_ack_at IS NULL`。**

**注 2:** 这张表的"层"列不是注释,是**规范性约束**。`verify-rebuild` 的穷尽字段表**必须**包含全部 L1 人工层列、**必须**排除全部 L2 可重算列([99](./99-acceptance.md) B13)。

**注 3:** 迁移 **必须**由 `drizzle-kit generate` 产出(m1-99 B7)。新增列**必须**全部可空且默认为空 —— M1 期已存在的文档在跑 S1 前保持空值。

## 6. `CorrectionSidecar` 扩展(审核 #004 A-4 / B-4)

```ts
export const CorrectionPersonReassign = z.object({
  schema_version: z.literal('1.1'),
  kind: z.literal('person_reassign'),
  seq: z.number().int().min(1),
  corrected_at: IsoDateTime,
  client_operation_id: Uuid,
  from_person_slug: PersonSlug, to_person_slug: PersonSlug, reason: z.string(),
}).strict();

export const CorrectionPageMove = z.object({
  schema_version: z.literal('1.1'),
  kind: z.literal('page_move'),
  seq: z.number().int().min(1),
  corrected_at: IsoDateTime,
  client_operation_id: Uuid,
  from_doc_short_id: DocShortId, to_doc_short_id: DocShortId,
  page_sha256: Sha256Hex,          // ★ 用内容摘要定位页,不用 key
  from_page_no: z.number().int().min(1), to_page_no: z.number().int().min(1),
}).strict();

export const CorrectionSidecar = z.discriminatedUnion('kind', [CorrectionPersonReassign, CorrectionPageMove]);
```

1. **`page_sha256` 而非 key 定位页**:key 里的 `NN` 是拍摄序且永不改名(ADR-047),移页之后 key 与所属文档不再对应,只有内容摘要是稳定锚点。
2. **写在源文档目录**(页字节的物理归属地),目标侧**不写** —— 否则一次移页会产生两条 `seq=1`。
3. **全局重放排序键 = `(corrected_at, from_doc_short_id, seq)`**。原版写 `(created_at, seq)`,而该 schema 里的时间字段叫 `corrected_at`,且 `seq` 是目录内计数器,跨目录做次键无意义(审核 #004 B-4)。**禁止**改用 S3 对象的 `LastModified`(不确定、可被复制改变)。
4. `schema_version` 升 `'1.1'` **必须**同步 `_meta/schemas`。

## 7. `ManifestLine` 的边界(审核 #004 B-5)

1. `split` **必须**追加 `ManifestAdd`(`origin='split'`)—— 新文档需要一条 add 行才能被 rebuild 建出骨架。
2. **`merge` 与 `move-page` 禁止写 manifests。** 页归属完全由 `correction-*.json` 承载。
   > 原版 `06 §3.1` 开头写"并在 manifests 追加",而 `ManifestLine` 是 `.strict()` 判别联合、只有 `add | person_correct` 两个 op,新增 op 要同步 contracts + `_meta` 两处 + rebuild —— 而这条代价换不来任何东西:回放已经能从 correction 得到全部页归属信息。

## 8. `AuditLine` 扩展(审核 #004 C-2)

`AuditLine` 当前是只含 `AuditAccessGrant`(`op ∈ access_grant|access_revoke`)的判别联合,而 [06](./06-corrections.md) §1.4 要求软删除写 audit ⇒ `appendAudit` 的 `AuditLine.parse` 会直接抛错。

**必须**新增 `AuditDocumentArchive`(`op='document_archive'`,含 `document_short_id`、`archived`、`by_account_id`、`reason`),并纳入 m1-99 B5 的三处同步断言。
