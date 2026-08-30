# API Contracts · P0-P4 Core

所有端点使用 `/api/v1`、Bearer JWT、snake_case 和 strict Zod schema。person 范围资源在无权限与不存在时统一 404。

## 1. 通用写入与游标契约

所有人工 mutation 包含：

```json
{
  "client_operation_id": "uuid-v7",
  "if_revision": 3
}
```

- create 的 `if_revision` 省略；PATCH/archive/complete/link 必填。
- L1 fact mutation 在删库重建前后都保证：同账户同 operation ID + 同 canonical request 返回安全的首次响应快照，异 payload 返回 `operation_conflict`。快照不含预签名 URL、token 或 secret。
- L2 job mutation（如 export create/retry）在 ledger 保留期间满足同一规则；DB 重建会清除旧 job，之后允许以同请求创建新 job。
- share create 是安全例外：首次响应含 token；重复 operation 只返回相同 share metadata、`token:null`、`token_recoverable:false`，绝不再次返回或持久化明文 token。
- stale revision 返回：

```json
{
  "error": {
    "code": "revision_conflict",
    "base_revision": 3,
    "current": { "revision": 4 },
    "draft": { "title": "本地草稿" }
  }
}
```

列表都以 JSON base64url cursor 保存冻结的 `[sort_key,id]`，查询条件变化时 cursor 无效。默认/最大 limit 为 30/100。

## 2. 能力发现

### `GET /api/v1/capabilities`

```json
{
  "processing_mode": "off",
  "core": {
    "document_metadata": true,
    "keyword_search": true,
    "context": true,
    "observations": true,
    "trends": true,
    "exports": true
  },
  "assist": {
    "available": false,
    "plugins": [],
    "capabilities": []
  }
}
```

请求失败时 Web 必须 fail closed 为 core-only，不能猜测模型能力。

## 3. P0 文档、元数据与迁移

### `GET /api/v1/documents`

参数：`person_id` required；`encounter_id/doc_type/facility_id/department/from/to/q/cursor/limit` optional；`date_field=best_available|sampled|reported|encounter|capture`，默认 `best_available`。

- `sampled/reported/capture` 分别使用对应日期；`encounter` 匹配任一关联 encounter，排序值取最新 `occurred_on`。
- `best_available=COALESCE(sampled_on,reported_on,latest_encounter_on,captured_at::date)`。
- `from/to` 为含首尾日期；显式 date_field 下 NULL 行不匹配范围。排序固定 `(selected_date DESC NULLS LAST,captured_at DESC,id DESC)`，cursor 保存三元组与 date_field。

每项返回：

```json
{
  "id": "uuid",
  "person_id": "uuid",
  "encounter_id": "uuid",
  "captured_at": "...",
  "original_filename": "report.pdf",
  "page_count": 3,
  "effective_metadata": {
    "doc_type": { "value": "lab_report", "source": "manual", "suggestion_id": null },
    "sampled_on": { "value": "2026-08-28", "source": "manual", "suggestion_id": null },
    "reported_on": { "value": null, "source": "capture_fallback", "suggestion_id": null },
    "facility_name": { "value": "某医院", "source": "capture_fallback", "suggestion_id": null },
    "department": { "value": null, "source": "capture_fallback", "suggestion_id": null },
    "title": { "value": "血脂检查", "source": "manual", "suggestion_id": null },
    "note": { "value": null, "source": "capture_fallback", "suggestion_id": null }
  },
  "dates": {
    "sampled_on": "2026-08-28",
    "reported_on": null,
    "latest_encounter_on": "2026-08-29",
    "captured_on": "2026-08-30",
    "selected_date": "2026-08-28",
    "selected_date_field": "best_available"
  },
  "revision": 2,
  "assist_suggestion_count": 1
}
```

### `GET /api/v1/documents/:id`

返回列表字段、page 当前投影、preview capability、encounters、context summary、observation count、medication count 和未确认 suggestion 列表。图片/PDF 都必须给可查看 URL；服务端无法生成 PDF 缩略图时仍给原件下载/浏览器打开路径。

### `PATCH /api/v1/documents/:id/metadata`

Auth：editor。JSON Merge Patch；省略不变、显式 null 清空。除通用字段外可写：`doc_type/sampled_on/reported_on/facility_id/facility_name_raw/department/title/note`。响应返回新 revision 与逐字段 effective value/source/provenance。

### suggestion 与旧数据迁移

- `GET /api/v1/documents/:id/metadata-suggestions`
- `GET /api/v1/metadata-migration-inbox?person_id=&cursor=&limit=`
- `POST /api/v1/documents/:id/metadata-suggestions/:suggestion_id/accept`
- `POST /api/v1/metadata-migration-inbox:batch-accept`

接受请求必须列出 `fields`，每字段可提供人工 override；响应包含逐字段 before/after。批量最多 50 个 document，逐项返回成功/冲突，且每项使用独立 operation ID 与 if_revision。撤销使用普通 metadata PATCH，journal 不删除旧事件。

建议 API 在插件关闭后仍返回历史 L2 建议；只有“生成新建议”受 capability 限制。

### `GET /api/v1/facilities?q=&limit=`

仅返回当前账户可访问事实已经使用的机构与受信任内置 registry。新原文可直接保存，不自动创建全局 facility。

## 4. P0 就诊与核心搜索

### encounter

- `GET /api/v1/people/:person_id/encounters?from=&to=&cursor=&limit=`，排序 `(occurred_on DESC,id DESC)`。
- `POST /api/v1/people/:person_id/encounters`
- `PATCH /api/v1/encounters/:id`
- `POST /api/v1/encounters/:id/documents`

字段：`encounter_type/occurred_on/ended_on/occurred_at/facility_id/department/chief_complaint/diagnosis_text/doctor_advice`。link 请求含完整目标 `document_ids`、通用 operation 和 if_revision，只允许同 person。

### `GET /api/v1/search`

参数：`person_id,q(1..100),mode=keyword|semantic|hybrid,entity_type,doc_type,facility_id,department,encounter_id,from,to,cursor,limit`。

结果不是 document-only：

```json
{
  "results": [{
    "entity_type": "observation",
    "entity_id": "uuid",
    "document_id": null,
    "person_id": "uuid",
    "title": "低密度脂蛋白胆固醇 3.62 mmol/L",
    "occurred_on": "2026-08-28",
    "highlights": ["<em>低密度</em>脂蛋白胆固醇"],
    "matched_by": ["confirmed_observation"]
  }],
  "next_cursor": null,
  "coverage": "core_manual"
}
```

`entity_type=document|encounter|context_answer|observation|medication|timeline_event`。keyword 永远可用；semantic/hybrid 无能力返回 409 `capability_unavailable`。AI OCR 命中必须标 `ai_ocr` 和 `core_plus_assist`。

## 5. P1 离线情境与媒体

### 模板

- `GET /api/v1/context/templates` 返回 manifest/version/hash。
- `GET /api/v1/context/templates/:template_id/versions/:version` 返回可缓存 snapshot、条件规则，以及 timeline 问题的 `timeline_kind/event_time_source=answer_value|document_sampled_on|session_started_at|none`；`answer_value` 只允许 date/datetime 题。

模板未知或未缓存时，离线 UI 允许跳过情境并稍后补录，不能阻止文档上传。

### session

- `POST /api/v1/context/sessions`
- `POST /api/v1/context/sessions/:id/bind-document`
- `GET /api/v1/context/sessions/:id`
- `GET /api/v1/context/pending?person_id=&local_date=&cursor=&limit=`
- `POST /api/v1/context/sessions/:id/answers`
- `POST /api/v1/context/sessions/:id/complete`

客户端生成 session UUID。`scope_type=document|standalone`；document scope 使用与现有 capture contract 一致的 8..64 字符稳定 client document ID，standalone 用独立 UUID 字符串，因而 anytime session 不需伪造文档：

```json
{
  "client_operation_id": "uuid",
  "id": "uuid",
  "person_id": "uuid",
  "scope_type": "document",
  "scope_key": "uuid",
  "client_document_id": "uuid",
  "document_id": null,
  "encounter_id": null,
  "template_id": "lab-report",
  "template_version": 1,
  "template_hash": "sha256",
  "question_snapshot": [],
  "stage": "onsite"
}
```

`client_document_id` 只在 document scope 必填，standalone scope 必须为 null。服务端校验 snapshot hash。bind 只适用于 document scope，按 `(document.uploaded_by=context_session.created_by,document.client_document_id)` 现有唯一域查找，再事务内断言 person 一致；因此兼容 `split:<uuid>` 等既有值。answer batch 最多 30 题，每题带 `question_key/answer_type/value/skipped`；audio/photo 的 value 只接受已 finalize 的 `upload_id`，不接受任意 object key。complete 带 if_revision；所有题可跳过。

### 情境媒体

- `POST /api/v1/context/uploads/prepare`
- `POST /api/v1/context/uploads/:upload_id/presign`
- `POST /api/v1/context/uploads/:upload_id/finalize`

prepare 请求绑定 `{person_id,session_id,question_key,kind:audio|photo,mime,byte_size,sha256}`。允许 MIME 白名单、大小上限与 multipart；finalize 重新验证 S3 对象大小/hash/归属，成功后返回不可伪造的 upload reference。ASR capability 不影响上传。

## 6. P2 概念与 observation

### 概念目录和人工 alias

- `GET /api/v1/medical/concepts?q=&kind=&limit=`：搜索仓库内版本化 catalog。
- `GET /api/v1/people/:person_id/observation-mapping-inbox`
- `POST /api/v1/people/:person_id/concept-aliases`
- `PATCH /api/v1/concept-aliases/:id`
- `POST /api/v1/people/:person_id/observation-mapping-inbox:resolve`

alias 请求包含 local name fingerprint、可选 specimen/method context、所选 concept、catalog version 和通用 operation。它是人工 L1 decision；不得要求 AI proposal。

resolve 请求最多 100 行，包含 `mode=selected|same_fingerprint`、目标 concept/catalog snapshot，以及每个 `observation_id/if_revision`。服务端在单一事务内创建/更新 alias decision、更新所有目标 observation 的 `concept_code/catalog_version/series_key/revision`，并追加对应 decision + observation L1 事件；任一 revision 冲突则整批 409 并返回冲突 rows，不产生半批。成功响应返回可立即加入监控组的 series selectors。

### observation

- `GET /api/v1/people/:person_id/observations`
- `POST /api/v1/people/:person_id/observations:batch`
- `PATCH /api/v1/observations/:id`
- `POST /api/v1/observations/:id/archive`

筛选支持 `concept_code/local_name/mapping_status/from/to/source/review_status/document_id/cursor/limit`，排序 `(observed_on DESC,observed_at DESC NULLS LAST,id DESC)`。

batch 最多 100 行，并支持报告级 defaults：

```json
{
  "client_operation_id": "uuid",
  "defaults": {
    "document_id": "uuid",
    "encounter_id": null,
    "observed_on": "2026-08-28",
    "observed_at": null,
    "time_precision": "date",
    "specimen": "serum",
    "method": null,
    "device": null
  },
  "observations": [{
    "client_row_id": "uuid",
    "local_name": "低密度脂蛋白胆固醇",
    "concept_code": "LDL_C",
    "concept_catalog_version": "2026.08",
    "loinc_code": null,
    "qualifier": null,
    "body_site": null,
    "extra_dims": null,
    "value_raw": "<3.62",
    "value_num": 3.62,
    "comparator": "<",
    "value_text": null,
    "value_dimensions": null,
    "unit_raw": "mmol/L",
    "unit_ucum": "mmol/L",
    "ref_low": 0,
    "ref_high": 3.37,
    "ref_text": null,
    "ref_unit": "mmol/L",
    "abnormal_flag_raw": "↑",
    "result_kind": "measured",
    "specimen_label": "血清",
    "measurement_setting": null,
    "source_page": {
      "origin_capture_document_id": "uuid",
      "origin_capture_order": 1,
      "object_sha256": "64-hex",
      "logical_page_index": 1,
      "bbox": null
    }
  }]
}
```

人工创建为 `source=manual,review_status=confirmed`。unknown unit/missing concept 仍保存，分别返回 warning；未映射事实进入 inbox，不能加入 concept trend。PATCH 必须含 correction_note + if_revision，archive 同样带 if_revision。

### suggestion

- `GET /api/v1/documents/:id/observation-suggestions`
- `POST /api/v1/documents/:id/observation-suggestions/:suggestion_id/accept`

接受请求列出 suggestion row ids、字段 override 和 operation；创建的 L1 event 保存完整 accepted snapshot 与 plugin/model/prompt/artifact provenance。L2 工件删除不影响事实回放。

### 显式提升 context answer

`POST /api/v1/context/answers/:id/promote` 接受 `target_type=medication|observation` 和完整目标 draft，展示预览后按对应事实 API 契约创建；不能静默写入。

## 7. P3 监控组与趋势

- `GET /api/v1/people/:person_id/metric-groups`
- `POST /api/v1/people/:person_id/metric-groups`
- `PATCH /api/v1/metric-groups/:id`
- `POST /api/v1/metric-groups/:id/archive`
- `GET /api/v1/metric-groups/:id/trend?from=&to=&cursor=&limit=&max_points=`

group item 必须使用已映射 concept，并含完整 series selector：`concept_code/qualifier/body_site/specimen/method/device/measurement_setting/extra_dims/result_kind`。创建时可选内置“三高+”模板，但复制后成为用户自己的 L1 group。

trend 返回 point 的 `observed_on/observed_at/time_precision/value/ref/fact_source/series_key/source_page/source_available/calculation_version`。0 点给录入 CTA；1 点明确“尚无趋势”；大数据按固定 LTTB 版本下采样并返回 `total_points/downsampled`，全量导出另取。

## 8. P4 用药、预览、导出和分享

### medication

- `GET /api/v1/people/:person_id/medications?from=&to=&kind=&cursor=&limit=`
- `POST /api/v1/people/:person_id/medications:batch`
- `PATCH /api/v1/medications/:id`
- `POST /api/v1/medications/:id/archive`

字段：`kind/name_raw/generic_name/dose_raw/dose_value/dose_unit/concentration_pct/solute_mass_g/frequency_raw/route/administration_group/group_volume_ml/sequence/administered_at/started_on/ended_on/source_page/note`。`administered` 必须有 administered_at；`prescribed` 必须有 started_on。人工事实、revision、journal 和稳定来源规则与 observation 一致。

### timeline event

- `GET /api/v1/people/:person_id/timeline-events?from=&to=&kind=&cursor=&limit=`
- `POST /api/v1/people/:person_id/timeline-events`
- `PATCH /api/v1/timeline-events/:id`
- `POST /api/v1/timeline-events/:id/archive`

字段：`kind/title/occurred_on/occurred_at/time_precision/note/source_page?`。这是用户显式记录的中性事实，不接受诊断推断字段；通用 revision、operation、journal 和稳定来源规则适用。

### export

- `POST /api/v1/exports/preview`
- `POST /api/v1/exports/person-bundle`
- `POST /api/v1/exports/visit-summary`
- `GET /api/v1/people/:person_id/exports?state=&kind=&cursor=&limit=`
- `GET /api/v1/exports/:id`
- `POST /api/v1/exports/:id/retry`
- `GET /api/v1/exports/:id/download`

preview 返回内容范围、缺口、事件/趋势数量、原件总字节估算、预计页数和 `source_revision_hash`。visit-summary 支持 `metric_group_ids/from/to/include_events/include_undated_events(default true)/include_originals/format=pdf|png`。日期范围按各实体 canonical date 相交；无日期事件在单独分区显示。原件超过配置上限返回 422 并建议缩小范围或 person bundle；不会静默截断。

person export 列表按 `(created_at DESC,id DESC)` 稳定分页，当前 person_access 即“内部授权”；viewer 只看到 done 且可下载的项目，owner/editor 还看到 pending/running/failed。每项返回 state/stale/size/snapshot_at/source_revision_hash。

状态响应含 `pending|running|done|failed`、attempt、progress、result size/hash、renderer/font hash、snapshot_at、source_revision_hash、`stale`。对象缺失时 download 返回 409 `export_artifact_missing`，retry 以原 canonical request 重新入队。

### share

- `POST /api/v1/exports/:id/shares`（owner only）
- `DELETE /api/v1/exports/:id/shares/:share_id`（owner only）
- `GET /api/v1/exports/:id/shares`（owner only）
- `GET /api/v1/shared/exports/:token`（public）

创建需确认 `expires_in_seconds`（300..604800）和当前 export 范围；只在首次成功响应返回 256-bit token。相同 operation 重试只返回 share metadata 和不可恢复标记，不再次返回 token。public 响应统一 404、`Cache-Control: private, no-store`、按 token hash/IP 限流，访问日志只写 share id/result，不写 token、文件名、person 或内容。

## 9. 错误码

| HTTP | code | 含义 |
|---|---|---|
| 409 | `operation_conflict` | operation ID 已用于不同 payload |
| 409 | `revision_conflict` | base revision 过期，返回 base/current/draft |
| 409 | `capability_unavailable` | 可选辅助能力未启用 |
| 409 | `export_artifact_missing` | 导出对象丢失，可 retry |
| 409 | `source_mismatch` | person/document/page/session 归属不一致 |
| 422 | `batch_row_invalid` | 返回行号和字段错误，整批不写入 |
| 422 | `export_too_large` | 返回估算与缩小范围建议 |
| 422 | `export_has_no_confirmed_data` | 无可导出的确认事实 |
| 429 | `share_rate_limited` | 公开分享访问超限 |
