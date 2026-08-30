# Database Design · P0-P4 Core

PostgreSQL 16 + Drizzle。迁移必须可从零重放；所有 L1 projection 都可从 S3 journal/decisions 重建。

## 1. 新表与现有表调整

新增 17 张表：

1. `document_manual_metadata`
2. `processing_suggestion`（L2）
3. `operation_ledger`（L2 幂等缓存）
4. `context_session`
5. `context_answer`
6. `context_upload`
7. `concept_alias_decision`
8. `observation`
9. `metric_group`
10. `metric_group_item`
11. `medication`
12. `timeline_event`
13. `search_entry`（L2 可重建索引）
14. `export_job`（L2/L3）
15. `export_share`（安全状态）
16. `processing_plugin`（L2）
17. `processing_job`（L2）

现有 `encounter` 增加 `revision/updated_by/updated_at/archived_at`；现有 `document` 保留兼容 AI 列但核心读路径不把它们当事实。旧 `human_operation` 和 `ai_job` 只为兼容旧流程保留，Core 新端点不再扩展它们。

## 2. 通用规则

- 可编辑 L1 表都有 `revision integer not null default 1`、`updated_by`、`updated_at`、可归档实体的 `archived_at`。
- 业务更新使用 `WHERE id=? AND revision=?`，成功后 `revision=revision+1`。
- person/document/encounter/session/page 归属在同一事务校验。
- ID 均 UUID v7；日期精度不能用伪造午夜填补。

### `operation_ledger`

| 字段 | 类型 | 约束 |
|---|---|---|
| `account_id` | uuid | FK account |
| `client_operation_id` | uuid | required |
| `kind` | text | registry enum |
| `subject_type` | text | document/encounter/context_session/observation/metric_group/medication/timeline_event/export/share/concept_alias |
| `subject_id` | uuid nullable | create 前可空 |
| `person_id` | uuid nullable | 权限查询 |
| `request_hash` | char(64) | canonical JSON SHA-256 |
| `request/result` | jsonb | 首次请求/安全响应；不得含 URL/token/secret |
| `created_at` | timestamptz | required |

PK：`(account_id,client_operation_id)`。它本身是 L2 缓存；L1 fact event 的 `operation_replay` 足以在 rebuild 时恢复对应 ledger 行。L2-only job/share 操作在 DB 重建后失效，不从 person journal 恢复。

## 3. P0 文档人工元数据与建议

### `document_manual_metadata`

| 字段 | 类型 | 约束 |
|---|---|---|
| `document_id` | uuid | PK/FK document |
| `doc_type` | text nullable | contracts DocType |
| `sampled_on/reported_on` | date nullable | |
| `facility_id` | uuid nullable | FK facility |
| `facility_name_raw` | text nullable | max 300 |
| `department` | text nullable | max 200 |
| `title` | text nullable | max 300 |
| `note` | text nullable | max 4000 |
| `field_provenance` | jsonb | 每个非空/显式清空字段 `{source,event_id,suggestion_id?}` |
| `revision/updated_by/updated_at` | | 通用规则 |

provenance source 仅 `manual|accepted_suggestion`；capture fallback 不写本表。facility 引用事件必须携带完整 facility snapshot。

索引：`(sampled_on,document_id)`、`facility_id`。搜索不直接依赖这些 GIN，而写入统一 `search_entry`。

### `processing_suggestion`（L2）

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK，稳定 suggestion id |
| `capability` | text | metadata/observation/... |
| `subject_type/subject_id` | text/text | document 等；允许 family subject |
| `person_id` | uuid nullable | FK person |
| `input_revision/input_sha256` | integer/char(64) | 防止过期建议 |
| `payload` | jsonb | 严格 suggestion snapshot |
| `plugin_id/plugin_version` | text | required |
| `provider/model/prompt_id/prompt_version` | text nullable | provenance |
| `artifact_key/artifact_sha256` | text nullable | 可选 S3 工件 |
| `state` | text | proposed/partially_accepted/accepted/rejected/superseded |
| `accepted_fields` | text[] | metadata 逐字段状态 |
| `created_at/updated_at` | timestamptz | |

唯一索引：`(capability,subject_type,subject_id,plugin_id,plugin_version,input_sha256)`。接受时 L1 event 复制 payload 中被接受字段及全部 provenance，不依赖此表回放。

## 4. P1 情境与媒体

### `context_session`

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK，由客户端生成 |
| `person_id` | uuid | FK person |
| `scope_type/scope_key` | text/text | document/standalone + 8..64 字符稳定本地 key |
| `client_document_id` | text nullable | 8..64；document scope required，standalone null |
| `document_id` | uuid nullable | FK document，后绑定 |
| `encounter_id` | uuid nullable | FK encounter |
| `template_id/template_version/template_hash` | text/int/char(64) | required |
| `question_snapshot` | jsonb | 完整问题/条件/timeline_kind 快照 |
| `stage` | text | onsite/same_day/anytime |
| `status` | text | active/completed |
| `revision/created_by/created_at/updated_by/updated_at` | | |
| `completed_at` | timestamptz nullable | |

唯一：`(person_id,scope_type,scope_key,template_id,template_version,stage)`。document 绑定不改变 session 身份。

### `context_answer`

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `session_id/question_key` | uuid/text | unique pair |
| `question_text/question_snapshot` | text/jsonb | 当时快照 |
| `answer_type` | text | choice/multi_choice/number/text/date/datetime/audio/photo |
| `value` | jsonb nullable | strict discriminated value |
| `upload_id` | uuid nullable | FK finalized context_upload |
| `skipped` | boolean | skipped 时 value/upload 为空 |
| `answered_at` | timestamptz nullable | 用户事实时间 |
| `event_on/event_at/time_precision/event_time_source` | date/timestamptz/text/text nullable | 仅 timeline_kind，按模板规则确定 |
| `revision/updated_by/updated_at` | | |

ASR transcript 不在 L1 表；它是 processing suggestion/artifact。

### `context_upload`

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `person_id/session_id/question_key` | uuid/uuid/text | required |
| `kind` | text | audio/photo |
| `mime/byte_size/sha256` | text/bigint/char(64) | prepare 声明 |
| `object_key` | text | L1 key，服务端生成 |
| `state` | text | prepared/uploading/finalized/expired |
| `multipart_state` | jsonb nullable | parts/etag |
| `created_by/created_at/finalized_at` | | |

finalize 后不可改归属、hash 或 key；answer 只能引用同 session/question 的 finalized upload。sidecar 携带全部完整性字段。

## 5. P2 概念与 observation

### `concept_alias_decision`

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK |
| `person_id` | uuid | FK person required；P0-P4 不提供 family/global alias |
| `input_fingerprint` | char(64) | local name + 可选 specimen/method context |
| `local_name/context` | text/jsonb | 原值快照 |
| `concept_code/display_name` | text | catalog 项 |
| `catalog_version` | text | required |
| `state` | text | confirmed/superseded |
| `revision/decided_by/decided_at/updated_at` | | |

唯一 active：`(person_id,input_fingerprint) WHERE state='confirmed'`。它不要求 AI proposal，按该 person journal L1 回放；跨 person 复用只来自公开静态 catalog，不复用用户 alias。

### `observation`

| 组 | 字段 |
|---|---|
| 身份 | `id`, `person_id`, `document_id?`, `encounter_id?`, `client_row_id?` |
| 时间 | `observed_on date`, `observed_at? timestamptz`, `time_precision=date|minute|unknown`, `date_source=manual|document_sampled|document_reported` |
| 概念 | `local_name`, `concept_code?`, `concept_catalog_version?`, `loinc_code?`, `qualifier?`, `body_site?`, `extra_dims?`, `series_key?` |
| 数值 | `value_raw`, `value_num?`, `comparator?`, `value_text?`, `value_dimensions?` |
| 单位 | `unit_raw?`, `unit_ucum?`, `value_si?`, `unit_si?`, `conversion_version?` |
| 区间 | `ref_low?`, `ref_high?`, `ref_text?`, `ref_unit?`, `abnormal_flag_raw?`, `abnormal_flag?` |
| 上下文 | `specimen?`, `specimen_label?`, `method?`, `device?`, `measurement_setting?`, `result_kind=measured|calculated|input_parameter`, `collected_at?`, `reported_at?`, `lab_facility_id?` |
| 稳定来源 | `origin_capture_document_id?`, `origin_capture_order?`, `object_sha256?`, `logical_page_index?`, `source_bbox?`, `current_document_id?`, `current_page_no?` |
| 来源/审查 | `source=manual|imported|accepted_suggestion|derived`, `source_ref?`, `review_status=confirmed|corrected`, `reviewed_by?`, `reviewed_at?`, `consistency_flags` |
| 派生 | `is_derived`, `derived_formula?`, `calculation_version?`, `derivation_key?`, `input_observation_ids?`, `input_revision_hash?` |
| 并发 | `revision`, `created_by?`, `created_at`, `updated_by?`, `updated_at`, `archived_at?` |

约束：

- `observed_on` 必填；仅在有真实时刻时填 observed_at。
- `series_key=sha256(canonical(concept + all series dimensions))`；concept 为空时 series_key 为空。
- 稳定来源字段必须全有或全空；origin capture document id 对应最初 CaptureSidecar.document_id，capture order 对应最初 pages[].capture_order，logical page index 在对象内从 1 起，object SHA 用于完整性；bbox 为 0..1。当前 document/page 仅为可重建导航投影。
- accepted suggestion 的 `source_ref` 保存 suggestion snapshot/provenance；derived 保存完整依赖图字段。
- `result_kind=input_parameter` 默认不进趋势；不同 specimen/method/device/setting/body_site/qualifier 不合线。

索引：

- `(person_id,concept_code,observed_on DESC,observed_at DESC,id DESC)`
- `(person_id,archived_at,review_status,id)`
- `(person_id,concept_code,series_key,observed_on DESC,id DESC)`
- `(origin_capture_document_id,origin_capture_order,logical_page_index)`
- `(person_id,concept_code) WHERE concept_code IS NULL AND archived_at IS NULL`

同一文档行唯一性以 `client_row_id` 或稳定 source row identity 保证，禁止仅用 concept_code 去重。

## 6. P3 监控组

### `metric_group`

`id,person_id,name,description?,preset_origin?,revision,created_by,created_at,updated_by,updated_at,archived_at?`。

索引：`(person_id,archived_at,updated_at DESC,id DESC)`。

### `metric_group_item`

`id,metric_group_id,position,item_type,concept_code,qualifier?,body_site?,specimen?,method?,device?,measurement_setting?,extra_dims?,result_kind?,series_selector_hash`。

唯一：`(metric_group_id,position)`、`(metric_group_id,series_selector_hash)`。完整 group snapshot 随 group journal 一起写，不单独产生日志事件。

## 7. P4 用药与搜索

### `medication`

| 组 | 字段 |
|---|---|
| 身份 | `id,person_id,encounter_id?,kind=prescribed|administered` |
| 药物 | `name_raw,generic_name?,dose_raw?,dose_value?,dose_unit?,concentration_pct?,solute_mass_g?` |
| 执行 | `frequency_raw?,route?,administration_group?,group_volume_ml?,sequence?` |
| 时间 | `administered_at?,started_on?,ended_on?`；administered 要求 administered_at，prescribed 要求 started_on |
| 来源 | 与 observation 相同的 origin capture/order/object SHA/logical page/bbox + current projection，及 `note?` |
| 审计 | `source=manual|imported|accepted_suggestion,source_ref?,revision,created_by,created_at,updated_by,updated_at,archived_at?` |

索引：`(person_id,COALESCE(administered_at,started_on::timestamptz) DESC,id DESC)`、`(origin_capture_document_id,origin_capture_order,logical_page_index)`。

### `timeline_event`

`id,person_id,encounter_id?,kind,title,occurred_on,occurred_at?,time_precision,note?`，以及与 observation 相同的稳定来源/current projection、`revision,created_by,created_at,updated_by,updated_at,archived_at?`。

`kind` 为中性 registry（procedure/hospitalization/symptom/change/other），不得承载模型诊断。索引：`(person_id,occurred_on DESC,occurred_at DESC,id DESC)`、稳定来源复合索引。

### `search_entry`（L2）

`id,person_id,entity_type,entity_id,document_id?,occurred_on?,sort_at?,title,core_body,assist_body?,source_revision_hash,updated_at`。

- unique `(entity_type,entity_id)`；GIN trgm on `title/core_body`，assist corpus 单独列与标记。
- keyword core 只查 title/core_body；由 journal replay/backfill 确定性重建。
- 索引 `(person_id,sort_at DESC,id DESC)`、`(person_id,entity_type,sort_at DESC,id DESC)`。

## 8. 导出与分享

### `export_job`

| 字段 | 类型/说明 |
|---|---|
| `id,person_id,kind,client_operation_id,request,request_hash` | canonical request |
| `source_revision_hash,snapshot_at,input_manifest` | 固定输入 provenance |
| `state` | pending/running/done/failed |
| `attempt,max_attempts,next_attempt_at` | retry |
| `locked_at,locked_by,lease_expires_at` | claim/lease |
| `progress,last_error` | 状态 |
| `renderer_id,renderer_version,font_manifest_hash` | 固定渲染环境 |
| `result_key,result_sha256,result_byte_size,result_content_hash` | 输出 |
| `created_by,created_at,updated_at,completed_at` | |

唯一 `(created_by,client_operation_id)`；ready 索引 `(state,next_attempt_at,id)`。worker 使用 `FOR UPDATE SKIP LOCKED`，lease 超时回 pending，指数退避；对象缺失可将同 job 重新置 pending，保留 attempt/audit。stale 由当前 person source revision hash 与 job hash 比较，不改历史输出。

### `export_share`

`id,export_job_id,token_hash(unique),expires_at,created_by,created_at,revoked_at,last_accessed_at?,access_count`。明文 token 永不落 DB/log。创建/撤销均验证 export person 的 owner role。

## 9. 插件队列

### `processing_plugin`

`plugin_id,plugin_version,capabilities[],last_heartbeat_at,metadata`；metadata 禁止 secrets。

### `processing_job`

| 字段 | 说明 |
|---|---|
| `id,capability,target_plugin_id,target_plugin_version` | enqueue 时从有效 heartbeat 冻结；只有完全匹配的 worker 可 claim |
| `subject_type` | document/context_answer/person/family |
| `subject_id` | text；uuid 或稳定 family key |
| `person_id` | nullable，family job 必须 null |
| `input_revision,input_sha256` | 输入身份 |
| `run_generation` | 显式 rerun 序号 |
| `dedup_key` | capability+target plugin/version+subject+input+generation |
| `state,attempt,max_attempts,next_attempt_at,locked_at,locked_by,lease_expires_at` | 可恢复队列 |
| `result_key,result_sha256,last_error,created_at,updated_at` | |

旧 `ai_job` 不转换。新 backfill 只依据 L1 输入与所需 capability 创建新 job；历史 confirmed decisions 单独回放。

## 10. Journal / decisions 冻结载荷

统一事件 envelope：

```ts
{
  schema_version: '1.0';
  event: EventName;
  event_id: Uuid;
  at: IsoDateTime;
  by_account_id: Uuid;
  client_operation_id: Uuid;
  person_slug: PersonSlug;
  subject_id: Uuid;
  revision: number;
  after: StrictSnapshot;
  before?: StrictSnapshot;
  operation_replay: {
    request_hash: Sha256Hex;
    response_snapshot: SafeMutationResponse;
  };
  references: {
    facility?: FacilitySnapshot;
    page?: {
      origin_capture_document_id: Uuid;
      origin_capture_order: number;
      object_sha256: Sha256Hex;
      logical_page_index: number;
    };
    concept?: { code: string; display_name: string; catalog_version: string };
    suggestion?: AcceptedSuggestionSnapshot;
  };
}
```

每个 `StrictSnapshot` 是对应 projection 的完整 strict Zod schema，不允许只保存 patch。事件：

1. `document_metadata_upsert`
2. `encounter_upsert`
3. `encounter_documents_set`
4. `context_session_upsert`（含本地 create/bind/completion 后完整 snapshot）
5. `context_answer_upsert`
6. `context_media_finalize`
7. `concept_alias_upsert`
8. `observation_upsert`
9. `observation_archive`
10. `metric_group_upsert`
11. `metric_group_archive`
12. `medication_upsert`
13. `medication_archive`
14. `timeline_event_upsert`
15. `timeline_event_archive`

person journal 的 `after` 必含全部逐字段 provenance、问题 snapshot、稳定 page identity 或 concept snapshot。`concept_alias_upsert` 也是 person journal 事件。observation/medication accepted suggestion 的 references 保存被接受 payload 与 plugin provenance。rebuild 从 `operation_replay` 恢复 fact mutation ledger；derived observation、search entry、trend cache、processing/export job 不进 person journal，它们按 L1 重算。

既有来源迁移：对每个原始 capture sidecar，用 `(CaptureSidecar.document_id,pages[].capture_order,pages[].sha256,logical_page_index)` 生成 origin identity；split/merge/move 沿 correction 链只更新 current projection。重复 SHA 由 capture_order 区分；多页对象由 logical_page_index 区分。无法唯一回溯的旧来源保留事实并置 `source_available=false`，不得猜测。

同步修改 contracts union、registry、schema snapshots、`_meta/README`、bundle filter、rebuild 和二次重建幂等测试。

## 11. L1/L2 对象

L1 新增：context audio/photo + sidecar；上述 journal/decision 行。  
L2/L3：suggestions、ASR、processing jobs/artifacts、derived observations、search/trend cache、exports。

删除全部 L2/L3 后，人工事实、历史已接受事实、概念 alias 和重新生成 P3/P4 的能力必须完整。
