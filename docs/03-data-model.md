# 03 · 数据模型

## 0. 总览

```
account ──< person_access >── person ──< person_identifier
                                 │
                                 ├──< encounter ──< document ──< document_page
                                 │                     │
                                 │                     ├──< extraction (版本化)
                                 │                     │        └──< observation
                                 │                     └──< context_session ──< context_answer
                                 │
                                 ├──< medication
                                 └──< metric_group ──< metric_group_item

facility ──< encounter / document / observation
```

**分层含义:**

- **不可变层**:`document`、`document_page` —— 原件,写入后永不修改
- **派生层**:`extraction`、`observation` —— 可重跑、可版本化
- **人工层**:`context_answer`、`observation.review_status` —— 人的输入与确认,优先级高于机器

---

## 1. 账号与档案

### `account` — 登录主体

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `email` | text unique | |
| `password_hash` | text | |
| `display_name` | text | |
| `timezone` | text | 默认 `Asia/Shanghai` |
| `created_at` | timestamptz | |

### `person` — 档案主体(第一层级)

⚠️ **`sex_at_birth` 与 `birth_date` 不是装饰性字段。** 它们决定参考区间与派生指标的计算 —— 血红蛋白、肌酐、尿酸、铁蛋白的参考区间按性别分;eGFR 的 CKD-EPI 2021 公式需要年龄与性别;儿童的参考区间随年龄剧烈变化。详见 [08 · 医学参考层](./08-medical-reference.md)。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `slug` | text unique | **ASCII、短、稳定** —— 用作 S3 key 的一段,如 `p3f7a2`。生成后永不更改 |
| `display_name` | text | 姓名 |
| `name_pinyin` | text | 拼音,用于检索与 ASCII 场景 |
| `birth_date` | date | **存出生日期,不存年龄** —— 年龄会腐烂 |
| `sex_at_birth` | enum(`male`,`female`,`unknown`) | 用于参考区间与公式计算 |
| `gender` | text nullable | 社会性别,仅用于展示,不参与计算 |
| `relation_to_owner` | enum(`self`,`spouse`,`parent`,`child`,`sibling`,`other`) | |
| `blood_type` | text nullable | |
| `allergies` | jsonb | `[{substance, reaction, severity, noted_on}]` |
| `chronic_conditions` | jsonb | `[{name, icd10?, diagnosed_on?}]` |
| `note` | text | |
| `created_at` / `updated_at` / `archived_at` | timestamptz | 软删除 |

> 身高、体重、腰围**不放在这里** —— 它们随时间变化,是 `observation`(LOINC 8302-2 身高、29463-7 体重、56086-2 腰围)。

### `person_identifier` — 各医院的院内标识

同一个人在不同医院的就诊卡号/病历号不同。存下来能帮助 AI 自动归人。

| 字段 | 类型 |
|---|---|
| `id` | uuid PK |
| `person_id` | uuid FK |
| `facility_id` | uuid FK nullable |
| `identifier_type` | enum(`patient_id`,`card_no`,`medical_record_no`,`other`) |
| `identifier_value` | text |

唯一约束:`(facility_id, identifier_type, identifier_value)`

### `person_access` — 授权(多用户地基)

| 字段 | 类型 | 说明 |
|---|---|---|
| `account_id` | uuid FK | |
| `person_id` | uuid FK | |
| `role` | enum(`owner`,`editor`,`viewer`) | |
| `granted_at` | timestamptz | |

PK `(account_id, person_id)`

> **所有数据查询必须经过这张表过滤。** Day 1 只有 N 行,但结构对了,多用户与共享档案的迁移成本几乎为零。

---

## 2. 机构与就诊

### `facility` — 医疗机构

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | 全称 |
| `aliases` | text[] | AI 识别到的各种写法,用于归一 |
| `slug` | text | **ASCII 短码**,用于 S3 key,如 `xiehe` |
| `city` | text nullable | |
| `level` | text nullable | 三甲 / 社区 等 |

### `encounter` — 就诊事件(组织单元)

**一次就诊会产生一叠文档** —— 挂号、化验单、超声报告、处方、门诊病历本。它们共享时间、机构、主诉。这是档案的自然组织单位。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `person_id` | uuid FK | |
| `encounter_type` | enum(`outpatient`,`inpatient`,`emergency`,`checkup`,`other`) | 门诊/住院/急诊/体检 |
| `facility_id` | uuid FK nullable | |
| `department` | text nullable | 科室 |
| `occurred_on` | date | **就诊日期** |
| `ended_on` | date nullable | 住院用 |
| `chief_complaint` | text | 主诉 / 为什么来 |
| `diagnosis_text` | text | 医生给的诊断(原文,不做解析) |
| `doctor_advice` | text | 医生口头说了什么 —— 常常不写在任何单子上 |
| `created_at` | timestamptz | |

---

## 3. 文档(不可变层)

### `document` — 逻辑文档

⚠️ **写入后除 `encounter_id` 外不再修改。** 归人(`person_id`)在上传时强制确认,之后修改需走人工纠正流程并记入 `audit_log`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `short_id` | text unique | 6 位 ASCII,用于 S3 key 与人工引用 |
| `person_id` | uuid FK | **★ 上传时强制人工确认** |
| `encounter_id` | uuid FK nullable | 可后补归组 |
| `doc_type` | enum | 见下表 |
| `doc_type_confidence` | numeric | AI 判定置信度 |
| `page_count` | int | |
| `source` | enum(`camera`,`album`,`pdf`,`screenshot`,`scan`,`import`) | |
| `original_filename` | text nullable | |
| `captured_at` | timestamptz | 拍摄时间(EXIF 优先,否则上传时间) |
| `sampled_on` | date nullable | **采样日期** —— 做趋势用这个 |
| `reported_on` | date nullable | **报告日期** |
| `collected_at` | timestamptz nullable | **采集时刻**(精确到分)—— 见下方说明 |
| `received_at` / `tested_at` / `verified_at` | timestamptz nullable | 接收 / 检验 / 审核时间 |
| `facility_id` | uuid FK nullable | 冗余自 encounter,便于直接筛选 |
| `report_no` | text nullable | **报告编号** —— 见下方说明 |
| `accession_no` | text nullable | 流水号 |
| `panel_name` | text nullable | 报告标题,如 `血气分析7`、`血常规(五分类)+超敏CRP` |
| `ordering_doctor` | text nullable | 申请医师 |
| `clinical_diagnosis` | text nullable | **报告上直接印的临床诊断** —— 见下方说明 |
| `performed_by` / `verified_by_name` | text nullable | 检验者 / 审核者 |
| `uploaded_by` | uuid FK account | |
| `status` | enum(`uploading`,`uploaded`,`needs_person_confirm`,`ready`,`failed`) | |
| `created_at` | timestamptz | |

> **三个日期必须分开存。** 采样日期 / 报告日期 / 就诊日期经常差好几天。做趋势用采样日期,找档案时人记得的往往是就诊日期。事后无法补救。

#### 三个从真实报告中学到的字段

以下三项来自 [真实用例 001](../fixtures/001-pediatric-emergency/case.md)(深圳市儿童医院急诊报告),是纸面设计时没想到的:

| 字段 | 为什么重要 |
|---|---|
| **`report_no`(报告编号)** | 中国医院报告普遍印有唯一报告编号(如 `926081701634`)。这是**天然的幂等键** —— 同一份单据被重复拍照上传时可自动去重,比 sha256 更可靠(重拍一张照片 sha256 就变了,报告编号不变)。建议加唯一约束 `(facility_id, report_no)`。 |
| **`collected_at`(采集时刻)** | 报告上印着精确到分钟的采集时间。**同一次抽血产生的多份报告,采集时刻完全相同** —— 这是 `encounter` 自动归组最强的信号,比"同日同院"精确得多。 |
| **`clinical_diagnosis`(临床诊断)** | 报告单上直接印着申请时的临床诊断(如 `呕吐查因`)。**不需要问用户** —— 问答模板里对应的问题应降级为"确认 / 补充",而不是从零提问。 |

#### `doc_type` 取值

| 值 | 中文 | 提取重点 |
|---|---|---|
| `lab_report` | 化验单 | 表格化数值,提取价值最高 |
| `imaging_report` | 影像报告(CT/MRI/超声/X 光) | **结论段** + 关键测量值;描述段全文索引 |
| `prescription` | 处方 / 用药清单 | 药名、剂量、频次 —— 解释化验值异常的一半答案在这里 |
| `discharge_summary` | 出院小结 | 诊断、治疗经过 |
| `outpatient_note` | 门诊病历 | 主诉、诊断 |
| `pathology` | 病理报告 | **临床权重最高,数量最少,绝不能丢** |
| `checkup_report` | 体检报告 | 是个合集,含十几种检查,需能拆分 |
| `ecg` | 心电图 | 结论 |
| `vaccination` | 疫苗接种记录 | 疫苗名、剂次、日期 |
| `other` / `unknown` | | |

### `document_page` — 页

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `document_id` | uuid FK | |
| `page_no` | int | 从 1 开始 |
| `storage_key` | text | **S3 中原件的 key,不可变** |
| `content_sha256` | text | 完整性校验 |
| `byte_size` | bigint | |
| `mime_type` | text | |
| `width` / `height` | int | 像素 |
| `thumb_key` | text nullable | 缩略图(派生物,可重建) |
| `page_label` | text nullable | 页脚原文,如 `第1页,共2页` |
| `capture_order` | int | **拍摄顺序** —— 与 `page_no` 分开存 |

唯一约束:`(document_id, page_no)`

> ⚠️ **`page_no` 必须从页脚的「第 N 页,共 M 页」解析,不能等同于拍摄顺序。**
> 真实场景中用户经常先拍到第 2 页(纸是折叠的、翻页顺序反了)。而多页报告的项目编号是**跨页连续**的(第 1 页 NO 1–20,第 2 页 NO 21–27),顺序错了会导致提取结果错乱。
> `capture_order` 单独保留,用于排查上传问题。

---

## 4. 提取(派生层,版本化)

### `extraction` — 一次提取批次

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `document_id` | uuid FK | |
| `version` | int | 该 document 下自增 |
| `model_id` | text | 如 `claude-opus-5` |
| `prompt_version` | text | 如 `extract-lab-report.v3` |
| `pipeline_version` | text | 代码版本 |
| `status` | enum(`pending`,`running`,`succeeded`,`failed`,`superseded`) | |
| `is_active` | bool | **每个 document 至多一个 true** |
| `full_text` | text | **★ AI 读出的完整文本 —— 全文索引的源,兜底能力** |
| `full_text_embedding` | vector(1536) | 语义检索 |
| `structured` | jsonb | 结构化结果原样保存 |
| `confidence_overall` | numeric | |
| `input_tokens` / `output_tokens` | int | 成本追踪 |
| `error` | text nullable | |
| `superseded_by` | uuid FK nullable | |
| `started_at` / `finished_at` | timestamptz | |

**重跑规则:** 生成新 `extraction` 并置 `is_active`,旧版标 `superseded`。旧记录**不删除** —— 它是"当时机器怎么读的"的凭证。

### `observation` — 结构化检验值

这是承接全部医学要求的核心表。**每个字段都对应一个具体的失真风险。**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `person_id` | uuid FK | 冗余,查询性能 |
| `document_id` | uuid FK | |
| `extraction_id` | uuid FK | 溯源到哪次提取 |
| `encounter_id` | uuid FK nullable | |
| **概念标识** | | |
| `concept_code` | text | 内部指标字典 code,如 `LDL_C` |
| `qualifier` | text nullable | **限定词**,如 `corrected`(校正)。见下方 ⚠️ |
| `loinc_code` | text nullable | 国际标准编码 |
| `local_name` | text | **报告上的原始名称** —— 永远保留 |
| **数值** | | |
| `value_raw` | text | 原样字符串,如 `"< 0.01"`、`"阴性"` |
| `value_num` | numeric nullable | 可解析的数值 |
| `comparator` | enum(`=`,`<`,`>`,`<=`,`>=`) nullable | 处理 `<0.01` 这类结果 |
| `value_text` | text nullable | 定性结果:阴性/阳性/+/++ |
| `unit_raw` | text | 报告上的原始单位 |
| **标准化(派生)** | | |
| `value_si` | numeric nullable | 换算到规范单位后的值 |
| `unit_si` | text nullable | UCUM 单位码 |
| `conversion_version` | text | 用了哪版换算规则 |
| **参考区间** | | |
| `ref_low` / `ref_high` | numeric nullable | **该次报告自带的区间** |
| `ref_text` | text nullable | 非数值型区间,如 `"阴性"` |
| `ref_unit` | text nullable | |
| `abnormal_flag` | enum(`H`,`L`,`HH`,`LL`,`N`,`A`) nullable | 报告上的 ↑↓ |
| **上下文** | | |
| `method` | text nullable | 方法学(流式细胞计数法 / 电阻抗法 / 散射比浊法…) |
| `device` | text nullable | **检测仪器**,如 `血气iSTAT1-300G`、`BC-7500-2`。见下方 ⚠️ |
| `result_kind` | enum(`measured`,`calculated`,`input_parameter`) | 实测 / 仪器计算 / 输入参数。见下方 ⚠️ |
| `specimen` | enum(`serum`,`plasma`,`whole_blood`,`urine`,`other`) nullable | |
| `collected_at` | timestamptz nullable | 采样时刻(含时间,昼夜节律相关指标需要) |
| `reported_at` | timestamptz nullable | |
| `lab_facility_id` | uuid FK nullable | 检验机构 |
| **质量与溯源** | | |
| `confidence` | numeric | AI 置信度 |
| `consistency_flags` | jsonb | 自洽校验结果,如 `["wbc_differential_sum_mismatch"]` |
| `review_status` | enum(`unreviewed`,`confirmed`,`corrected`,`rejected`) | |
| `reviewed_by` | uuid FK nullable | |
| `reviewed_at` | timestamptz nullable | |
| `source_bbox` | jsonb nullable | `{page_no, x, y, w, h}` —— **点回原图的坐标** |
| `is_derived` | bool | true 表示系统计算的派生指标(eGFR 等),非报告原值 |
| `derived_formula` | text nullable | 如 `CKD-EPI-2021` —— 公式版本必须记录,否则前后不可比 |
| `created_at` | timestamptz | |

> ⚠️ **`ref_low`/`ref_high` 必须跟着每一条数值走,而不是在系统里定义一套全局"正常范围"。**
> 不同医院用不同仪器与试剂,参考区间本身就不同。同样的 ALT 45 U/L,在上限 40 的实验室是 ↑,在上限 50 的实验室是正常。这一条如果做错,整个系统的可信度归零。

#### ⚠️ 三个来自真实报告的字段

来源:[真实用例 001](../fixtures/001-pediatric-emergency/case.md)。

**1. `qualifier` —— 同一份报告里同一指标会出现两次**

血气报告同时给出「氧分压 65」与「氧分压(校正) 67」,**参考区间还不一样**(83–108 / 80–100);pH、二氧化碳分压同理。若都映射到同一个 `concept_code`,趋势图上会出现同一时刻两个点。

```
唯一性由 (document_id, concept_code, qualifier) 决定,而非 concept_code 单独决定
```

**2. `device` —— 同一管血、同一指标,不同仪器给出不同值**

真实案例(同一次采血 17:07,两台仪器):

| | 血气 iSTAT1-300G | 血常规 BC-7500-2 |
|---|---|---|
| 血红蛋白 | 12.60 **g/dL** = 126 g/L | 130 **g/L** |
| 红细胞比容 | 37 % | 38.1 % |
| 参考区间 | 12–17 g/dL(**成人范围**) | 112–149 g/L(**儿童范围**) |

两个数都是对的 —— 方法学不同(iSTAT 从 HCT 推算,血球仪比色法实测)。**但如果天真地把两个 Hb 都归一到 g/L 画进同一条趋势线,会出现"同一天两个血红蛋白值"。**

→ 趋势查询必须能按 `device` 分组或标注;详见 [08 · 医学参考层](./08-medical-reference.md#13-同一管血不同仪器)。

**3. `result_kind` —— 报告上有些行不是检验结果**

血气报告里的「体温 37.5℃」和「吸氧浓度 21.00%」是**血气分析仪的输入参数**(用于计算校正值),不是测量结果。「红细胞比容计算值」「二氧化碳总量」是仪器计算值。

| 取值 | 含义 | 是否进趋势 |
|---|---|---|
| `measured` | 仪器实测 | ✅ |
| `calculated` | 仪器由其他值计算 | ⚠️ 可进,但**同一指标存在实测值时优先用实测** |
| `input_parameter` | 操作者输入的参数 | ❌ 不进趋势,仅作上下文 |

---

**重跑保护:** 当 `review_status ∈ (confirmed, corrected)` 时,重跑提取**不覆盖**该记录 —— 人工修正永远优先于机器提取。

---

## 5. 情境问答

### `context_session`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `person_id` | uuid FK | |
| `document_id` | uuid FK nullable | |
| `encounter_id` | uuid FK nullable | |
| `template_id` | text | 如 `lab-report` |
| `template_version` | text | **★ 模板版本化** —— 两年后要知道当时问的是哪一版的哪一题 |
| `stage` | enum(`onsite`,`same_day`,`later`) | 现场必答 / 当天补 / 随时补 |
| `started_at` / `completed_at` | timestamptz | |

### `context_answer`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `session_id` | uuid FK | |
| `question_key` | text | 如 `fasting_status` |
| `question_text_snapshot` | text | **当时问题的原文** —— 模板会变,快照不变 |
| `answer_type` | enum(`choice`,`multi_choice`,`number`,`datetime`,`text`,`audio`) | |
| `value_choice` / `value_number` / `value_text` / `value_datetime` | | |
| `audio_key` | text nullable | **S3 中的原始音频 —— 与影像同级,永不删除** |
| `audio_duration_ms` | int nullable | |
| `transcript` | text nullable | 转写文本(派生层) |
| `transcript_model` | text nullable | |
| `transcript_version` | int | 可重跑 |
| `structured` | jsonb nullable | AI 从自由回答里抽出的结构 |
| `skipped` | bool | 跳过必须零成本 |
| `answered_at` | timestamptz | |

> 音频与影像遵循同一原则:**原始录音是真相,转写是可再生的派生层。** 今天的模型认不出的方言或专业词,以后能认出来。

---

## 6. 用药与监控组

### `medication`

| 字段 | 类型 |
|---|---|
| `id` | uuid PK |
| `person_id` | uuid FK |
| `name` | text |
| `generic_name` | text nullable |
| `dose` / `frequency` / `route` | text |
| `started_on` / `ended_on` | date nullable |
| `source_document_id` | uuid FK nullable |
| `note` | text |

### `metric_group` / `metric_group_item`

用户自定义的长期监控组(如"三高")。预置模板见 [08 · 医学参考层](./08-medical-reference.md#5-推荐监控组)。

```
metric_group      (id, person_id, name, description, is_template, created_at)
metric_group_item (group_id, concept_code, display_order, note)
```

---

## 7. 审计

### `audit_log`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | uuid FK | 是谁操作的 |
| `person_id` | uuid FK nullable | 动了谁的数据 |
| `action` | text | `document.reassign_person`、`observation.correct` … |
| `entity_type` / `entity_id` | text / uuid | |
| `before` / `after` | jsonb | |
| `at` | timestamptz | |

**必须记入审计的操作:** 归人变更、observation 人工修正、文档删除、权限授予/撤销。

---

## 8. 索引

```sql
-- 检索主路径
CREATE INDEX ON document (person_id, sampled_on DESC);
CREATE INDEX ON document (person_id, doc_type, sampled_on DESC);
CREATE INDEX ON document (facility_id, sampled_on DESC);
CREATE INDEX ON encounter (person_id, occurred_on DESC);

-- 趋势查询(最热路径)
CREATE INDEX ON observation (person_id, concept_code, collected_at DESC);

-- 待处理队列
CREATE INDEX ON document (status) WHERE status <> 'ready';
CREATE INDEX ON observation (review_status) WHERE review_status = 'unreviewed';

-- 每个 document 至多一个 active extraction
CREATE UNIQUE INDEX ON extraction (document_id) WHERE is_active;

-- 全文与语义
CREATE INDEX ON extraction USING gin (full_text gin_trgm_ops);
CREATE INDEX ON extraction USING ivfflat (full_text_embedding vector_cosine_ops);
```

## 9. 与 FHIR / LOINC 的关系

不引入完整 FHIR 实现(个人项目里是过度工程),但**对齐核心概念**,让数据在几年后仍然可用、甚至可被医疗系统消费:

| 本项目 | 对应 | 说明 |
|---|---|---|
| `person` | FHIR `Patient` | |
| `encounter` | FHIR `Encounter` | |
| `document` | FHIR `DocumentReference` | |
| `observation` | FHIR `Observation` | 字段刻意对齐 |
| `concept_code` → `loinc_code` | LOINC | 指标编码 |
| `unit_si` | UCUM | 单位编码 |
| `medication` | FHIR `MedicationStatement` | |

导出为 FHIR Bundle 的能力留在 P4 之后,但字段设计现在就不挡路。
