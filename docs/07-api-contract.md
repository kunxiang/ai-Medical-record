# 07 · API 契约

## 0. 约定

| 项 | 规则 |
|---|---|
| Base | `/api/v1` |
| 认证 | `Authorization: Bearer <JWT>` |
| JSON 字段 | `snake_case`(与数据库一致,减少映射层) |
| 时间 | ISO 8601 带时区;纯日期字段用 `YYYY-MM-DD`(无时区) |
| 分页 | 游标式 `?cursor=&limit=`,响应含 `next_cursor` |
| 错误 | 见 §7 |
| 契约来源 | `packages/contracts` —— 类型与 Zod schema 的唯一真相 |

> **每个涉及数据的接口都必须经过 `person_access` 过滤。** 这不是可选的中间件,是安全边界。

---

## 1. 档案(Person)

```
GET    /api/v1/people                     列出我有权访问的档案
POST   /api/v1/people                     建档
GET    /api/v1/people/:id
PATCH  /api/v1/people/:id
DELETE /api/v1/people/:id                 软删除(archived_at)

GET    /api/v1/people/:id/identifiers     院内标识
POST   /api/v1/people/:id/identifiers
DELETE /api/v1/people/:id/identifiers/:iid
```

### `POST /people`

```json
{
  "display_name": "张三",
  "name_pinyin": "zhangsan",
  "birth_date": "1980-05-12",
  "sex_at_birth": "male",
  "relation_to_owner": "self",
  "blood_type": "A+",
  "allergies": [{ "substance": "青霉素", "reaction": "皮疹", "severity": "moderate" }],
  "chronic_conditions": [{ "name": "高血压", "diagnosed_on": "2021-06-01" }]
}
```

响应含服务端生成的 `slug`(此后不可变):

```json
{ "id": "…", "slug": "p3f7a2", "display_name": "张三", "…": "…" }
```

> `birth_date` 与 `sex_at_birth` 为必填 —— 它们决定参考区间与派生指标计算,不是可选的展示字段。

---

## 2. 上传与归档

### 三步走

```
① POST /uploads/presign     取预签名 URL
② PUT  <presigned_url>       前端直传 S3(不过后端)
③ POST /documents            登记文档 + 归人确认
```

### `POST /api/v1/uploads/presign`

```json
// 请求
{
  "files": [
    { "filename": "IMG_0042.jpg", "mime_type": "image/jpeg", "byte_size": 2481920, "sha256": "a3f…" }
  ]
}
// 响应
{
  "uploads": [
    {
      "upload_id": "u_9k2m",
      "url": "https://…",
      "method": "PUT",
      "headers": { "Content-Type": "image/jpeg" },
      "expires_at": "2024-03-15T11:32:45+08:00"
    }
  ]
}
```

### `POST /api/v1/documents`

```json
{
  "person_id": "…",                  // ★ 必填,已由用户确认
  "person_confirmed": true,          // ★ 必须显式为 true,否则 400
  "encounter_id": null,              // 可后补
  "source": "camera",
  "captured_at": "2024-03-15T10:32:11+08:00",
  "pages": [
    { "upload_id": "u_9k2m", "page_no": 1, "width": 3024, "height": 4032, "sha256": "a3f…" }
  ],
  "client_document_id": "local-uuid"  // ★ 幂等键 —— 离线队列重试用
}
```

**`client_document_id` 是必需的。** 离线队列在弱网下会重试,没有幂等键就会产生重复文档。服务端以 `(account_id, client_document_id)` 唯一约束保证幂等。

响应:

```json
{
  "id": "…", "short_id": "d7k2m9",
  "status": "uploaded",
  "person_id": "…",
  "pages": [{ "page_no": 1, "storage_key": "people/p3f7a2/2024/…/page-01.jpg" }]
}
```

### 归人建议(仅用于对账与批量导入,[ADR-041](./adr.md#adr-041))

正常拍照流程**不调用**此接口 —— 归人是拍照时本地手选的(05 §2)。此接口只在两处使用:①服务端归人对账(比对 AI 读名与所选人);②批量导入时给 `needs_person_confirm` 文档预排序候选。

```
POST /api/v1/documents/suggest-person
```

```json
// 请求:{ "upload_id": "u_9k2m" }
// 响应
{
  "suggestions": [
    { "person_id": "…", "display_name": "张三", "confidence": 0.96,
      "matched_on": ["patient_identifier", "name"] },
    { "person_id": "…", "display_name": "张小三", "confidence": 0.31,
      "matched_on": ["name_similarity"] }
  ],
  "detected": { "patient_name": "张三", "patient_sex": "male", "patient_age_text": "44岁" }
}
```

> ⚠️ **服务端永远不接受"自动归人"。** `POST /documents` 必须带 `person_confirmed: true`,由人点过一次。**唯一例外:批量导入**可以 `person_confirmed: false` 入库,此时 `status = needs_person_confirm`,文档在确认前不参与趋势/汇总,只出现在确认队列里。

### 归人纠正

```
POST /api/v1/documents/:id/reassign-person
```

```json
{ "person_id": "…", "reason": "上传时选错了" }
```

写入 `audit_log`,并触发受影响 observation 的 `person_id` 级联更新。

### 归人对账与批量确认([ADR-041](./adr.md#adr-041))

服务端提取完成后,自动比对 AI 读到的姓名/证件号与上传时所选的 person。不一致时置 `document.person_mismatch = true` 并进入对账队列:

```
GET  /api/v1/person-mismatches                  待对账列表
POST /api/v1/documents/:id/resolve-mismatch     裁决单条
```

```json
// resolve-mismatch 请求
{ "resolution": "reassign", "person_id": "…" }      // AI 对了,改归属
// 或
{ "resolution": "keep", "note": "报告打的是曾用名" }  // 手选对了,AI 读错/读的是别名
```

批量导入的存量文档批量确认归属:

```
POST /api/v1/documents/batch-confirm-person
```

```json
{ "document_ids": ["…", "…"], "person_id": "…" }
```

逐条写 `audit_log`,确认后 `status` 离开 `needs_person_confirm`,文档进入正常管线。

---

## 3. 文档与就诊

```
GET    /api/v1/documents                  列表(见筛选参数)
GET    /api/v1/documents/:id              详情(含页、提取、问答)
PATCH  /api/v1/documents/:id              仅允许改 encounter_id / doc_type
DELETE /api/v1/documents/:id              软删除;S3 原件不删
GET    /api/v1/documents/:id/pages/:n/url 取原图预签名 URL(短有效期)
GET    /api/v1/documents/:id/pages/:n/thumb    缩略图(302 重定向到预签名 URL)
GET    /api/v1/documents/:id/pages/:n/preview  预览图(同上)

POST   /api/v1/captures/discard           记录"曾拍摄但放弃"(M1;写 journal capture_discard)

GET    /api/v1/encounters
POST   /api/v1/encounters
GET    /api/v1/encounters/:id
PATCH  /api/v1/encounters/:id
POST   /api/v1/encounters/:id/documents   把文档归入就诊事件
```

### `GET /documents` 筛选参数

| 参数 | 说明 |
|---|---|
| `person_id` | 必填 |
| `doc_type` | 可多值 |
| `facility_id` | |
| `department` | |
| `from` / `to` | 按 `sampled_on`;**M1 期按 `capture_date`**(无 AI 日期),M2 引入 `date_field=capture` 后语义迁移须记 CHANGES |
| `date_field` | `sampled` \| `reported` \| `encounter`,默认 `sampled` |
| `status` | |
| `cursor` / `limit` | |

> 三种日期分开可筛。做趋势用采样日期,找档案时人记得的往往是就诊日期。

---

## 4. 检索

### `GET /api/v1/search`

```
?person_id=…&q=转氨酶&mode=hybrid&doc_type=lab_report&from=2022-01-01
```

| 参数 | 说明 |
|---|---|
| `q` | 查询词 |
| `mode` | `keyword` \| `semantic` \| `hybrid`(默认) |
| 其余 | 与 `/documents` 筛选参数一致 |

```json
{
  "results": [
    {
      "document_id": "…", "short_id": "d7k2m9",
      "person": { "id": "…", "display_name": "张三" },
      "doc_type": "lab_report",
      "sampled_on": "2024-03-15",
      "facility": { "name": "北京协和医院" },
      "summary": "生化全项:血脂、肝功、肾功、血糖",
      "highlights": ["…丙氨酸氨基转移酶 <em>ALT</em> 58 U/L↑…"],
      "thumb_url": "https://…",
      "score": 0.87,
      "matched_by": ["keyword", "semantic"]
    }
  ],
  "next_cursor": null
}
```

**highlights 来自 `extraction.full_text`** —— 即使结构化提取失败,只要全文在,就能被找到。

---

## 5. 情境问答

```
GET  /api/v1/context/templates/:doc_type          取当前模板(含版本)
POST /api/v1/context/sessions                     创建会话
POST /api/v1/context/sessions/:id/answers         提交回答(可批量)
POST /api/v1/context/sessions/:id/complete
GET  /api/v1/context/pending                      待补录的问题(当天推送用)
POST /api/v1/uploads/presign-audio                取音频上传 URL
```

### `POST /context/sessions/:id/answers`

```json
{
  "answers": [
    { "question_key": "fasting_status", "answer_type": "choice", "value_choice": "fasting" },
    { "question_key": "collection_time", "answer_type": "datetime",
      "value_datetime": "2024-03-15T08:15:00+08:00" },
    { "question_key": "visit_reason", "answer_type": "audio", "audio_upload_id": "u_4h8n" },
    { "question_key": "current_symptoms", "skipped": true }
  ]
}
```

转写异步进行;`GET /context/sessions/:id` 返回 `transcript` 与 `transcript_status`。

---

## 6. 指标与趋势

```
GET  /api/v1/people/:id/observations           原始观测值(可筛 concept_code)
PATCH /api/v1/observations/:id                 人工修正(记 audit_log)
POST /api/v1/observations/:id/confirm          确认无误

GET  /api/v1/people/:id/metric-groups
POST /api/v1/people/:id/metric-groups
GET  /api/v1/metric-groups/:id/trend
GET  /api/v1/people/:id/review-queue           待核查队列(低置信/校验失败)
```

### `GET /metric-groups/:id/trend`

```json
{
  "group": { "id": "…", "name": "三高监控" },
  "series": [
    {
      "concept_code": "LDL_C",
      "display_name": "低密度脂蛋白胆固醇",
      "unit_si": "mmol/L",
      "cvi": 0.085,
      "points": [
        {
          "observation_id": "…",
          "collected_at": "2024-03-15T08:15:00+08:00",
          "value_si": 3.62,
          "ref_low": 0, "ref_high": 3.37,
          "ref_source_facility": "北京协和医院",
          "abnormal_flag": "H",
          "context": { "fasting": "fasting", "recent_illness": null },
          "document_id": "…", "page_no": 1,
          "source_bbox": { "x": 0.12, "y": 0.44, "w": 0.63, "h": 0.028 },
          "review_status": "confirmed",
          "change_from_previous": {
            "delta": 0.34,
            "delta_pct": 10.4,
            "exceeds_rcv": false,
            "rcv_threshold_pct": 23.6
          }
        }
      ]
    }
  ]
}
```

**每个点都携带三样东西:**

1. **该次报告自带的参考区间**(不是全局的)
2. **溯源信息**(`document_id` + `page_no` + `source_bbox`)—— 一键看原图
3. **`exceeds_rcv`** —— 中性的数据陈述,不是医学判断

> `change_from_previous` 只陈述"变化是否超出该指标的常规生物学波动",**不解释原因,不给结论**。

### `PATCH /observations/:id`

```json
{ "value_num": 0.86, "unit_raw": "mg/dL", "correction_note": "OCR 把 0.86 读成 8.6" }
```

服务端置 `review_status = corrected`,记 `audit_log`,并**在后续重跑中保护该记录不被覆盖**。

---

## 7. 导出

```
POST /api/v1/exports/visit-summary
GET  /api/v1/exports/:id                  轮询状态
GET  /api/v1/exports/:id/download
```

```json
{
  "person_id": "…",
  "metric_group_ids": ["…"],
  "from": "2021-01-01", "to": "2024-03-15",
  "include_events": true,        // 用药变更、住院、急性病时间轴
  "include_originals": true,     // 附录:原件影像
  "format": "pdf"
}
```

### 单人档案 bundle 导出(ADR-045)

"孩子成年带走自己的完整档案"的接口形态。bundle 的组成规则(前缀拷贝 + manifests 按人过滤回放 + decisions 共享/私有分类 + `_meta/` 全量)定义在 [04 §5](./04-storage-layout.md#5-打包与迁移adr-045),schema 在 `packages/contracts`:

```
POST /api/v1/exports/person-bundle        { "person_id": "…" }
GET  /api/v1/exports/:id                  轮询状态
GET  /api/v1/exports/:id/download         zip(L1 子集,不含任何 derived)
```

**导出内容的硬性约束:**

- ✅ 趋势表、事件时间轴、原件附录、数据来源标注
- ✅ 中性标注:「非空腹」「超出常规波动范围」「参考区间来自 X 医院」
- ❌ **不含任何 AI 解读、结论、风险评估、建议**

理由见 [00 · 愿景与范围](./00-vision-and-scope.md#3-非目标)。

---

## 8. 错误格式

```json
{
  "error": {
    "code": "person_confirmation_required",
    "message": "上传文档必须显式确认所属人员",
    "details": { "field": "person_confirmed" }
  }
}
```

| HTTP | code | 说明 |
|---|---|---|
| 400 | `validation_failed` | |
| 400 | `person_confirmation_required` | 未确认归人 |
| 401 | `unauthenticated` | |
| 404 | `not_found` | 资源不存在,**或存在但无权访问**(m0 spec 审核裁决:合并进 404,不泄露档案存在性;403 不再使用) |
| 409 | `duplicate_client_document_id` | 幂等键冲突(返回已有文档) |
| 409 | `document_immutable` | 试图修改不可变字段 |
| 413 | `file_too_large` | |
| 415 | `derivative_unavailable` | 该页类型不支持派生物(M1:PDF,设计债 D13) |
| 422 | `unsupported_media_type` | |
| 422 | `derivative_generation_failed` | 缩略图解码或缩放失败 |
| 429 | `rate_limited` | |
| 500 | `internal_error` | |
| 503 | `ai_provider_unavailable` | **归档不受影响,仅提取延后** |

---

## 9. 后台任务状态

```
GET /api/v1/jobs?document_id=…
```

```json
{
  "jobs": [
    { "type": "classify",   "status": "succeeded", "finished_at": "…" },
    { "type": "extract",    "status": "running" },
    { "type": "transcribe", "status": "pending" },
    { "type": "thumbnail",  "status": "succeeded" }
  ]
}
```

任一任务失败**不影响文档的归档状态** —— `document.status` 仍可为 `ready`。归档与提取是解耦的。
