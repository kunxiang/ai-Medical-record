# M2 Spec · 01 contracts 增量

单一出处纪律不变:枚举与 schema 只在 `packages/contracts` 定义,`packages/ai`、`apps/api`、`apps/web`、`tools` 一律引用。

## 1. 新增文件

| 文件 | 内容 |
|---|---|
| `src/ai.ts` | `Stage1Page` / `Stage1Out` / `PiiKind` / `S1Artifact` |
| `src/jobs.ts` | `AiJobKind` / `AiJobState` / `AiJobItem` / `AiJobListQuery` / `AiJobListResponse` |
| `src/normalization.ts` | `NormalizationKind` / `NormalizationState` / `NormalizationDecision` |
| `src/corrections.ts` | `ReassignRequest` / `SplitRequest` / `MergeRequest` / `MovePageRequest` / `ArchiveRequest` |

## 2. 新增枚举(必须同步迁移 CHECK,CI 断言 m0-99 B2)

```ts
export const PiiKind = z.enum(['phone','id_card','address','insurance_card','bank_card','other']);
export const AiJobKind = z.enum(['stage1','facility_normalize','encounter_suggest']);
export const AiJobState = z.enum(['pending','running','done','failed','needs_human','unsupported']);
export const NormalizationKind = z.enum(['facility','encounter']);
export const NormalizationState = z.enum(['proposed','confirmed','rejected']);
export const PersonCheck = z.enum(['match','mismatch','unknown','skipped']);
export const EventTimeSource = z.enum(['sampled_on','reported_on','capture_date']);
```

> 每个枚举 **必须**在迁移 SQL 里有对应 CHECK,值列表逐字相同 —— `ci:deps` 的 B2 会逐条比对。

## 3. M1 契约的修订

| # | 修订 | 理由 |
|---|---|---|
| 1 | `DocumentListItem` 增 `doc_type`、`doc_type_confidence`、`person_check`、`facility_name`(可空) | UI 需要在时间轴上直接显示类型与告警条,否则要为每张卡片再发一次请求 |
| 2 | `DocumentListQuery` 增 `person_check?`、`doc_type?`、`facility_id?`、`date_field?`(`capture_date\|sampled_on\|reported_on`,默认 `capture_date`) | 兑现 07 §3 的五个筛选参数;`from/to` 语义由固定 `capture_date` 改为按 `date_field` 选择(m1 偏差 #4 的回写) |
| 3 | `DocumentOut` 增 `archived_at`(可空) | 软删除 |

**禁止**修改任何 M0/M1 已落桶 sidecar 的 schema 版本语义。`capture.json`(2.0)与 `page-NN.json`(2.0)在 M2 **不变** —— AI 产出不进 L1。

## 4. 新增 journal 事件(4 个)

| 事件 | 何时写 | 载荷要点 |
|---|---|---|
| `person_check_ack` | 人工确认"归人告警可忽略" | `document_short_id`、`from_check`、`reason` |
| `person_reassign` | 归人纠正 | `document_short_id`、`from_person_slug`、`to_person_slug`、`reason`、`correction_seq` |
| `normalization_confirm` | 确认/否决归一或归组提议 | `kind`、`input_fingerprint`、`decision`(`confirmed\|rejected`)、`payload` |
| `document_archive` | 软删除 / 撤销归档 | `document_short_id`、`archived`(bool)、`reason` |

另有既有的文档边界事件三个,**必须**一并注册:`document_split`、`document_merge`、`document_move_page`。

规范性条文:

1. 七个事件 **必须**加入 `JOURNAL_EVENT_REGISTRY`,并由 `gen-meta` 同步至 `_meta/schemas`、`_meta/registries`、`_meta/README.md` 三处(m1-99 B5 会断言)。
2. 每个事件 **必须**由调用方传入客户端持久化的 `event_id`;`appendJournal` **禁止**覆盖它(M1 已修复的缺陷,不得回归)。
3. **禁止**为任何 AI 产出新增 journal 事件。判据见 [00](./00-scope.md) §4.4:模型说的话可以重来,人说的话不能。

## 5. 数据库新列汇总(迁移 0003)

| 表 | 列 | 类型 | 说明 |
|---|---|---|---|
| `document` | `doc_type_confidence` | `real` | 可空 |
| `document` | `sampled_on` / `reported_on` | `date` | 可空 |
| `document` | `department_raw` | `text` | 可空 |
| `document` | `person_check` | `text` | CHECK ∈ `PersonCheck`,默认 `'unknown'` |
| `document` | `archived_at` | `timestamptz` | 可空 |
| `document` | `s1_artifact_key` / `s1_prompt_version` | `text` / `integer` | 可空 |
| `document_page` | — | — | 无变更 |
| `encounter` | `event_time_source` | `text` | CHECK ∈ `EventTimeSource` |
| 新表 | `ai_job` | — | 见 [04](./04-jobs.md) §2 |
| 新表 | `normalization_decision` | — | 见 [05](./05-reconciliation.md) §2.3 |

1. 迁移 **必须**由 `drizzle-kit generate` 产出,**禁止**手写(m1-99 B7 的漂移断言会红)。
2. `document` 的 AI 派生列 **必须**全部可空且默认为空 —— M1 期已存在的文档在跑 S1 之前保持空值,**禁止**因新列而使旧行失效。
