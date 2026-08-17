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

normalization_decision(独立 —— 按输入指纹缓存 AI 归一化判断,见 §4b)
```

**分层含义:**

- **不可变层**:`document`、`document_page` —— 原件,写入后永不修改
- **派生层**:`extraction`、`observation` —— 可重跑、可版本化
- **决策层**:`normalization_decision` —— AI 归一化判断的持久缓存,同指纹确定性重放
- **人工层**:`context_answer`、`observation.review_status`、**已确认的归一化决策**、手动 observation、`metric_group`、person 编辑、归人裁决 —— 人的输入与确认,优先级高于机器,**不可从原件重建** → 写库事务内**双写追加 `people/{slug}/journal/`**(ADR-045,不是异步导出)

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

> 每次编辑重写 S3 `_person.json` **全量**快照(含 allergies / chronic_conditions / identifiers,ADR-045)并追加 journal `person_update` 事件 —— 过敏史是"只有人知道、原件里没有"的典型,数据库不能是它唯一的家。
>
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
| `scope` | enum(`long_term`,`single_visit`) | 登记号=长期,门诊号=单次 —— **归人只信长期标识** |

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
| `occurred_at` | timestamptz nullable | 就诊起始时刻(用于时间窗归组) |
| `chief_complaint` | text | 主诉 / 为什么来 |
| `diagnosis_text` | text | 医生给的诊断(原文,不做解析) |
| `doctor_advice` | text | 医生口头说了什么 —— 常常不写在任何单子上 |
| `created_at` | timestamptz | |

#### ⚠️ 归组用时间窗,不用日历日

[用例 004](../fixtures/004-influenza-visit/) 的急诊在**凌晨 05:09**。若某次就诊 23:50 挂号、次日 00:30 抽血,**按日历日归组会被拆成两次**。

```
归组条件:同人 + 同机构 + event_time 落在同一时间窗(如 ±12h)
```

**就诊内还有更细的一层 —— 采样事件。** 同一次就诊里,鼻拭子采于 05:09、末梢血采于 05:14,是**两次采样**:

```
encounter(就诊)
  └── 按 collected_at 聚合的采样事件
        └── document(报告)
```

> 这修正了[用例 001](../fixtures/001-pediatric-emergency/) 的说法:「同采集时刻是归组最强信号」—— 那是**采样事件**粒度,不是就诊粒度。无需为此建表,查询层按 `collected_at` 聚合即可。

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
| `capture_date` | date | **key 的日期段**(captured_at 按上传者时区折算,登记时写死;spec m0-02) |
| `client_document_id` | text | 幂等键,`(uploaded_by, client_document_id)` 唯一(07 §2;spec m0-02) |
| `sampled_on` | date nullable | **采样日期** —— 做趋势用这个 |
| `reported_on` | date nullable | **报告日期** |
| `collected_at` | timestamptz nullable | **采集时刻**(精确到分)—— 见下方说明 |
| `received_at` / `tested_at` / `verified_at` | timestamptz nullable | 接收 / 检验 / 审核时间 |
| `event_time` | timestamptz nullable | **统一时间轴用的事件时刻** —— 见下方 ⚠️ |
| `event_time_source` | text nullable | 该时刻取自哪个字段 |
| `exam_items` | jsonb nullable | 检查项目 / 覆盖范围(影像专用)—— 见下方 ⚠️ |
| `facility_id` | uuid FK nullable | 冗余自 encounter,便于直接筛选 |
| `report_no` | text nullable | **报告编号** —— 见下方说明 |
| `accession_no` | text nullable | 流水号 |
| `visit_no` | text nullable | 门诊号(单次标识,fixture 003 回填) |
| `specimen` / `specimen_label` | text nullable | 文档级标本类型(观测级可覆盖) |
| `panel_name` | text nullable | 报告标题,如 `血气分析7`、`血常规(五分类)+超敏CRP` |
| `ordering_doctor` | text nullable | 申请医师 |
| `clinical_diagnosis` | text nullable | **报告上直接印的临床诊断** —— 见下方说明 |
| `performed_by` / `verified_by_name` | text nullable | 检验者 / 审核者 |
| `report_notes` | text nullable | **备注栏原文**(报告自带的结果解释)—— 见下方 |
| `report_notes_source` | text | 固定 `report_original`,与系统生成内容区分 |
| `column_set` | jsonb nullable | 该报告的表头列集合 —— 见下方 ⚠️ |
| `uploaded_by` | uuid FK account | |
| `status` | enum(`uploading`,`uploaded`,`needs_person_confirm`,`ready`,`failed`) | `needs_person_confirm` 仅**批量导入**路径可达(ADR-041) |
| `created_at` | timestamptz | |

> **三个日期必须分开存。** 采样日期 / 报告日期 / 就诊日期经常差好几天。做趋势用采样日期,找档案时人记得的往往是就诊日期。事后无法补救。

#### 三个从真实报告中学到的字段

以下三项来自 [真实用例 001](../fixtures/001-pediatric-emergency/case.md)(深圳市儿童医院急诊报告),是纸面设计时没想到的:

| 字段 | 为什么重要 |
|---|---|
| **`report_no`(报告编号)** | 中国医院报告普遍印有唯一报告编号(如 `926081701634`)。这是**天然的幂等键** —— 同一份单据被重复拍照上传时可自动去重,比 sha256 更可靠(重拍一张照片 sha256 就变了,报告编号不变)。建议加唯一约束 `(facility_id, report_no)`。 |
| **`collected_at`(采集时刻)** | 报告上印着精确到分钟的采集时间。**同一次抽血产生的多份报告,采集时刻完全相同** —— 这是 `encounter` 自动归组最强的信号,比"同日同院"精确得多。 |
| **`clinical_diagnosis`(临床诊断)** | 报告单上直接印着申请时的临床诊断(如 `呕吐查因`)。⚠️ **这是为开单/计费服务的简化标签,不是完整临床图景** —— 真实案例中单据印「呕吐查因」,而家长描述本次就诊主因还包括腹泻。正确做法是**预填 + 让用户补充确认**,不是省掉提问。 |

#### ⚠️ `column_set` —— 列结构不可假设固定

[用例 004](../fixtures/004-influenza-visit/):同一医院、**同一天**的两份报告,列结构不同。

| 报告 | 列 |
|---|---|
| 血常规 | NO · 检验项目 · 结果 · 提示 · 参考区间 · **单位** · **检测仪器** · 检测方法 |
| COVID 抗原 | NO · 检验项目 · 结果 · 提示 · 参考区间 · 检测方法 |

COVID 单没有「单位」与「检测仪器」列。**按固定列序解析必然错位** → 必须按表头动态解析,并记录实际列集合。

#### `report_notes` —— 报告自带的结果解释

[用例 004](../fixtures/004-influenza-visit/) 的 COVID 单备注栏印着中英双语说明:

> 阴性结果表示:样本中没有检出新型冠状病毒抗原,但**不能完全排除感染**,可能与低病毒载量等因素相关,**需结合临床表现**,必要时核酸复查。

这是**报告原文的一部分**,不是系统生成的解读。必须原文保留并标注 `report_notes_source = report_original`,**不得与系统输出混淆**。

> 附带印证:连医院自己都在说「不能完全排除」「需结合临床表现」。系统更不该下结论。

#### ⚠️ `event_time` —— 跨文档类型的时间轴对齐

同一次就诊里,不同文档的"事件时刻"来自**不同字段,语义不同**,不能直接比大小:

| doc_type | event_time 取自 | 真实案例(同一次急诊) |
|---|---|---|
| `lab_report` | `collected_at`(采集时刻) | 17:07 |
| `imaging_report` | 报告时间(检查实际更早) | 16:54 |
| `infusion_order` | 打印时间 ≈ 开始给药 | 18:02 |
| `prescription` | 开具时间 | — |

排序后可知实际顺序是 **先超声 → 再抽血 → 再输液**。

`event_time_source` 必须记录取自哪个字段,否则时间轴的精度无从判断 —— 影像的"报告时间"晚于实际检查,而化验的"采集时刻"就是事件本身。

#### ⚠️ `exam_items` —— 影像报告的覆盖范围

影像报告的**检查项目栏**决定了这次查了什么。真实案例:

```
胃肠道及腹膜腔扫查超声【胃及十二指肠@@阑尾及系膜淋巴结@@下消化道】阴囊、双侧睾丸、附睾超声
```

`@@` 是 HIS 的字段分隔符,提取时拆成数组:

```json
["胃及十二指肠", "阑尾及系膜淋巴结", "下消化道", "阴囊", "双侧睾丸", "附睾"]
```

**为什么必须存:** 影像结论在两次检查间"消失",可能只是这次没查那个部位。不记录覆盖范围,系统会把"未提及"渲染成"已消失"。详见 [ADR-028](./adr.md#adr-028--影像结论的消失不等于问题消失)。

#### `doc_type` 取值

| 值 | 中文 | 提取重点 |
|---|---|---|
| `lab_report` | 化验单 | 表格化数值,提取价值最高 |
| `imaging_report` | 影像报告(CT/MRI/超声/X 光) | **结论段** + 关键测量值 + **检查覆盖范围**;描述段全文索引 |
| `prescription` | 处方 | 计划给药。药名、剂量、频次 |
| `infusion_order` | **输液单 / 注射单** | **已执行给药**。分组、途径、给药时刻 —— 见下方说明 |
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

## 3b. 叙述型报告

化验单是表格 → `observation` 行。**影像报告、病理报告、出院小结是叙述文本 + 结论列表**,结构完全不同。

### `report_narrative` — 1:1 挂在 document 上

适用 `doc_type ∈ (imaging_report, pathology, discharge_summary, outpatient_note)`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `document_id` | uuid PK FK | |
| `findings_text` | text | 「检查所见」/「镜下所见」—— 叙述段,全文索引 |
| `impression_text` | text | 「超声诊断」/「病理诊断」原文块 |
| `conclusions` | jsonb | **结论逐条数组** —— 见下方 ⚠️ |
| `recommendation` | text nullable | 「建议」,如 `必要时复查` |
| `technique` | text nullable | 检查技术 / 造影剂 / 机器型号 |
| `comparison_note` | text nullable | 报告里提到的与既往对比 |

```json
"conclusions": [
  { "text": "右侧睾丸鞘膜积液", "tags": ["鞘膜积液"], "laterality": "right" },
  { "text": "胃、肠管声像未见明显异常", "tags": ["胃肠"], "laterality": null }
]
```

> ⚠️ **结论必须逐条原文保留,不改写、不归一、不做语义解析。**
> 中文影像报告的措辞有规范含义:「未见明显异常」≠「正常」,「未显示明显占位性回声」是特定表述。
> `tags` 与 `laterality` 是**额外**加上去用于检索与分组的,原文永远是主体。

---

## 4. 提取(派生层,版本化)

### `extraction` — 一次提取批次

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `document_id` | uuid FK | |
| `version` | int | 该 document 下自增(重跑时 +1) |
| `round` | int | **闭环轮次**(1 起)—— 见下方 ★ |
| `triggered_by` | jsonb nullable | 触发本轮的失败规则;第 1 轮为 null |
| `parent_extraction_id` | uuid FK nullable | 上一轮 |
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

#### ★ `round` —— 校验驱动的多轮闭环

提取不是一轮。**校验失败不是终点,是"回原图重看"的信号。**

先验:**报告是自洽的,不自洽的是我的读法。** MCV / MCHC / PCT / HCO₃⁻ / 估算体积都是仪器自己算出来的,不可能与源数据不自洽(实证:4 个用例、26 次规则执行、零失败)。

```
version 1 ─ round 1 ──校验失败──> round 2(裁剪区域重读)──> round 3
                                                              │
                        同一 version 共享,is_active 指向最后一轮 ┘
```

- 同一 document 的多轮 extraction **共享一个 `version`**;`version` 只在整体重跑(换模型/换 prompt)时递增
- **每一轮读数全部留档** —— 轮次间的分歧本身是信息,与双次提取取差集同源
- 最多 3 轮;每轮失败数必须严格下降,否则中止转人工

详见 [06 · AI 管线](./06-ai-pipeline.md#防线-3校验驱动的多轮闭环重读)。

### `observation` — 结构化检验值

这是承接全部医学要求的核心表。**每个字段都对应一个具体的失真风险。**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `person_id` | uuid FK | 冗余,查询性能 |
| `document_id` | uuid FK **nullable** | 手动录入(家庭血压/体重)时为空 |
| `extraction_id` | uuid FK **nullable** | 溯源到哪次提取;手动录入为空 |
| `source` | enum(`extracted`,`manual`,`derived`) | 数据来源 |
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
| `value_dimensions` | jsonb nullable | **多维测量**,开放数组 `[{"label":"l","value":1.4,"unit":"cm"},…]` —— 2D/3D/角度均可(ADR-042)。见下方 ⚠️ |
| `body_site` | text nullable | **解剖部位**,如 `testis.left`(归一走 `body_site_map` 决策)。见下方 ⚠️ |
| `extra_dims` | jsonb nullable | 未晋升的序列维度(开放);与 qualifier / body_site / specimen / device / method / measurement_setting 共同构成 `series_key`(ADR-042) |
| `unit_raw` | text | 报告上的原始单位 |
| **标准化(派生)** | | |
| `value_si` | numeric nullable | 换算到规范单位后的值 |
| `unit_si` | text nullable | UCUM 单位码 |
| `conversion_version` | text | 用了哪版换算规则 |
| **参考区间** | | |
| `ref_low` / `ref_high` | numeric nullable | **该次报告自带的区间** |
| `ref_text` | text nullable | 非数值型区间,如 `"阴性"` |
| `ref_unit` | text nullable | |
| `abnormal_flag_raw` | text nullable | **报告上的原始符号** —— 见下方 ⚠️ |
| `abnormal_flag` | enum(`H`,`L`,`HH`,`LL`,`N`,`A`) nullable | 标准化后 |
| **上下文** | | |
| `method` | text nullable | 方法学(流式细胞计数法 / 电阻抗法 / 散射比浊法…) |
| `device` | text nullable | **检测仪器**,如 `血气iSTAT1-300G`、`BC-7500-2`。见下方 ⚠️ |
| `result_kind` | enum(`measured`,`calculated`,`input_parameter`) | 实测 / 仪器计算 / 输入参数。见下方 ⚠️ |
| `specimen` | text nullable | **开放受控词表**(ADR-042):serum / plasma / venous_blood / capillary_blood / nasal_swab / urine…;归一走 `specimen_map` 决策 |
| `specimen_label` | text nullable | 报告原文,如 `末梢血` |
| `measurement_setting` | text nullable | 测量情境:office / home / ambulatory_24h…(ADR-019 的承载,此前缺失) |
| `collected_at` | timestamptz nullable | 采样时刻(含时间,昼夜节律相关指标需要) |
| `reported_at` | timestamptz nullable | |
| `lab_facility_id` | uuid FK nullable | 检验机构 |
| **质量与溯源** | | |
| `confidence` | numeric | AI 置信度 |
| `normalization_decision_id` | uuid FK nullable | 概念/单位判断的决策溯源(§4b) |
| `consistency_flags` | jsonb | 自洽校验结果,如 `["wbc_differential_sum_mismatch"]` |
| `review_status` | enum(`unreviewed`,`confirmed`,`corrected`,`rejected`) | |
| `reviewed_by` | uuid FK nullable | |
| `reviewed_at` | timestamptz nullable | |
| `source_bbox` | jsonb nullable | `{page_no, x, y, w, h}` —— **点回原图的坐标** |
| `is_derived` | bool | true 表示系统计算的派生指标(eGFR 等),非报告原值 |
| `derived_formula` | text nullable | 如 `CKD-EPI-2021` —— 公式版本必须记录,否则前后不可比 |
| `created_at` | timestamptz | |

> ⚠️ **`ref_low`/`ref_high` 必须跟着每一条数值走,而不是在系统里定义一套全局"正常范围"。**
>
> 实证([用例 004](../fixtures/004-influenza-visit/)):**同一家医院、同一台 BC-7500-2、同一个 3 岁 0 月的孩子、相隔 7 天,27 项中 14 项参考区间不同。**
>
> | 项目 | 08-10(末梢血) | 08-17(静脉血) |
> |---|---|---|
> | WBC | 4.90–12.70 | 4.40–11.90 |
> | Hb | 115.0–150.0 | 112.0–149.0 |
> | LYMPH% | 26.0–67.0 | 23.0–69.0 |
>
> 原因(标本类型切换 or 实验室更新区间库)**从单据无法判定,但工程要求与原因无关**:
> **任何形式的参考区间缓存、复用、跨报告继承,都是错的。**

#### ⚠️ 5. `abnormal_flag_raw` —— 图例不可信

[用例 004](../fixtures/004-influenza-visit/) 的流感单:甲流**阳性**,提示列标的是 **`↑`**。
而同一张单的页脚图例明确印着 `※:阳性`。

**单据自己印的规范与自己的用法对不上。** 按图例硬编码映射 → 阳性被漏标。

→ `abnormal_flag_raw` 保留原始符号;标准化 flag 由**上下文判断**得出(结果「阳性」+ 参考区间「阴性」→ `A`),不由符号表查得。

#### ⚠️ 6. `specimen` 是趋势分组维度,不是元数据

同患者、同仪器、7 天:

| 指标 | 08-10 **末梢血** | 08-17 **静脉血** | 变化 |
|---|---|---|---|
| PLT | 216 | 417 | **+93%** |
| WBC | 4.68 | 7.02 | +50% |

**末梢血的血小板计数系统性偏低**(采集时血小板聚集黏附)。216 → 417 中标本类型贡献多少、真实变化多少,**数据本身分辨不了**。

→ 趋势按 `specimen` 分组或虚线标注;**跨标本类型不直接连线、不计算 RCV**。

#### ⚠️ 三个来自真实报告的字段

来源:[真实用例 001](../fixtures/001-pediatric-emergency/case.md)。

**1. `qualifier` —— 同一份报告里同一指标会出现两次**

血气报告同时给出「氧分压 65」与「氧分压(校正) 67」,**参考区间还不一样**(83–108 / 80–100);pH、二氧化碳分压同理。若都映射到同一个 `concept_code`,趋势图上会出现同一时刻两个点。

```
唯一性由 (document_id, concept_code, series_key) 决定 —— qualifier 是 series_key 的一个维度(ADR-042)
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

#### ⚠️ 4. `body_site` 与 `value_dimensions` —— 影像测量值

**影像报告里也有可纵向追踪的数值**,但形态与化验单完全不同。真实案例(同一儿童,相隔两年):

| | 2024-08-25 | 2026-08-17 |
|---|---|---|
| 左睾丸 | 1.3 × 0.7 × 0.6 cm | 1.4 × 0.6 × 0.9 cm(报告估算体积 0.39 cm³) |
| 右睾丸 | 1.3 × 0.7 × 0.7 cm | 1.3 × 0.7 × 0.8 cm(报告估算体积 0.37 cm³) |

**两个新问题:**

1. **测量值是三维的** —— 标量字段装不下 → `value_dimensions`
2. **解剖部位是新维度** —— 左睾丸与右睾丸是**两条独立的时间序列**。化验单没有这个概念,影像报告普遍有(左/右、上/下、各叶各段)

```
序列身份 = concept_code + series_key(全部序列维度映射的确定性哈希,ADR-042)
行唯一性 = (document_id, concept_code, series_key) —— 新维度不再迁移唯一键
```

**派生让历史可比:** 2024 那份没给体积,但椭球公式 `V = 0.5236 × L × W × H` 在 2026 那份上验证成立(左 0.3958 vs 报告 0.39 ✓),因此可以给 2024 补算,使两个时间点落到同一根轴上:

| | 2024(派生) | 2026(报告) |
|---|---|---|
| 左 | 0.286 cm³ | 0.39 cm³ |
| 右 | 0.334 cm³ | 0.37 cm³ |

派生值置 `is_derived = true`、`derived_formula = ellipsoid-0.5236`。

> ⚠️ **影像测量值没有参考区间。** 报告本身不给 —— 是否正常需按年龄生长曲线判断,而那超出系统职责。`ref_low`/`ref_high` 全部为 null,系统**绝不对影像测量值做任何正常/异常暗示**。

---

**重跑保护:** 当 `review_status ∈ (confirmed, corrected)` 时,重跑提取**不覆盖**该记录 —— 人工修正永远优先于机器提取。

---

## 4b. 归一化决策 —— AI 判断的持久层

固定规则表在异质单据面前不收敛([ADR-040](./adr.md))。"这是什么"类判断交给 AI,但 AI 判断必须**持久化、可确认、可重放** —— 这就是本表。

### `normalization_decision`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `decision_type` | text | **注册表模式**(ADR-043):清单注册于 `packages/contracts`,每型含指纹字段清单 + 确定性规范化规则 + 可逆性标记。首批:concept_map / unit_identify / **specimen_map** / **body_site_map** / row_merge / row_split / flag_semantics / facility_map / encounter_group / drug_name_strip / pii_identify / comparability / **concept_mint** |
| `fingerprint` | text | 规范化输入的指纹 —— **同指纹必得同决策** |
| `input` | jsonb | 原始输入(局部名 / 单位原文 / 上下文摘要) |
| `output` | jsonb | 判断结果(concept_code / UCUM 码 / 合并指令…) |
| `confidence` | numeric | |
| `rationale` | text | AI 给出的理由 —— 审计时回答"为什么 12.60 g/dL 变成了 126 g/L" |
| `model_id` / `prompt_version` | text | 决策产生时的模型与 prompt(版本护栏) |
| `status` | enum(`proposed`,`confirmed`,`rejected`,`superseded`) | |
| `decided_by` | uuid FK nullable | 确认人 |
| `hit_count` | int | 缓存命中次数 |
| `created_at` / `confirmed_at` | timestamptz | |

### 工作流

```
新数据 → 计算指纹 → 命中未失效决策?
              ├─是→ 直接复用(零成本、确定性重放)
              └─否→ AI 判断 → 写入 proposed
                      ├─ 映射类(可逆):高置信即生效,可批量撤销重放
                      └─ 合并类(有损):等待人工确认才生效
```

字典由此翻转:`concepts.json` 不再是人工维护的输入,而是**已确认决策的导出快照**(冷启动种子)。

### 三条硬约束

1. **合并类必须人工确认。** 拆分可逆,合并有损 —— 把「红细胞比容计算值」(iSTAT)并进「红细胞比积」(血球仪)会抹掉 2.9% 的真实方法学差异。反例断言见 [用例 001](../fixtures/001-pediatric-emergency/);与之相对,[用例 004](../fixtures/004-influenza-visit/) 的双语行**必须**合并 —— 一对方向相反的断言钉住判断边界。
2. **低置信不映射。** `concept_code` 置 null,原值照常入库,确认后重放补全。
3. **已确认决策是人工层。** 不可从原件重建 → 追加导出到 S3 `_index/decisions/`,维持"数据库可从 S3 重建"不变式;其词表注册表快照随 `_meta/registries/` 落桶(ADR-045)—— decisions 离开代码仓库必须仍可解读。

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
| `answer_type` | enum(`choice`,`multi_choice`,`number`,`datetime`,`text`,`audio`,`photo`) | photo:拍药盒等(模板第 7 题此前无枚举可用) |
| `value_choice` / `value_number` / `value_text` / `value_datetime` | | |
| `audio_key` | text nullable | **S3 中的原始音频 —— 与影像同级,永不删除** |
| `audio_duration_ms` | int nullable | |
| `transcript` | text nullable | 转写文本(派生层) |
| `transcript_model` | text nullable | |
| `transcript_version` | int | 可重跑 |
| `structured` | jsonb nullable | AI 从自由回答里抽出的结构 |
| `skipped` | bool | 跳过必须零成本 |
| `answered_at` | timestamptz | |

> 音频与影像遵循同一原则:**原始录音是真相,转写是可再生的派生层**(落 `derived/.../transcripts/`,ADR-045)。今天的模型认不出的方言或专业词,以后能认出来。
>
> 非语音答案(点选/数字/文字/日期/照片)没有"原件"可依托 —— **journal 追加行就是它们的 L1 落点**(ADR-045),与写库同事务双写。

---

## 6. 用药与监控组

### `medication`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `person_id` | uuid FK | |
| `kind` | enum(`prescribed`,`administered`) | **计划给药 vs 已执行给药** |
| `name_raw` | text | **报告原文** —— 含厂家、规格、集采批次 |
| `generic_name` | text nullable | 剥离采购信息后的通用名 |
| `dose_raw` | text | 原文剂量,如 `0.15克`、`50毫克`、`250毫升` |
| `dose_value` / `dose_unit` | numeric / text nullable | 归一后 |
| `concentration_pct` | numeric nullable | 浓度,如 `10`(表示 10%) |
| `solute_mass_g` | numeric nullable | 浓度×体积派生的溶质量(15%×3mL=0.45g KCl) |
| `frequency_raw` | text | **原文保留**,如 `ONCE`、`1天`、`每日一次` |
| `route` | text | `静滴` / `静脉续滴` / `口服` / `肌注` |
| `administration_group` | int nullable | **输液分组**,见下方 ⚠️ |
| `group_volume_ml` | numeric nullable | 该组总量 |
| `sequence` | int nullable | 组内顺序 / 组间先后 |
| `administered_at` | timestamptz nullable | **给药时刻(精确到分)** |
| `started_on` / `ended_on` | date nullable | 长期用药用 |
| `source_document_id` | uuid FK nullable | |
| `note` | text | |

#### ⚠️ 输液单不是处方

| | `prescribed`(处方) | `administered`(输液单/注射单) |
|---|---|---|
| 语义 | 计划给药 | **已执行给药** |
| FHIR | `MedicationRequest` | `MedicationAdministration` |
| 特有 | — | 分组、途径、护士执行签名 |

真实案例(一次急诊输液):

```
第1组(250 mL,静滴):
  5% 葡萄糖注射液      250 mL
  10% 氯化钠注射液      10 mL
  15% 氯化钾注射液       3 mL
  维生素B6注射液        50 mg
第2组(100 mL,静脉续滴):
  0.9% 氯化钠注射液    100 mL
  西咪替丁注射液       0.15 g
```

**同组药物混在同一袋液体里输**,共享给药时刻与速度。扁平结构装不下 → `administration_group` + `sequence`。

#### ⚠️ 这是"分析前变异"的最强形态

同一次急诊中,血气采样在 17:07,输液单打印于 18:02 —— **补钾补钠补糖之后再抽血,电解质与血气结果与输液前不可同日而语**。

这比「最近在吃什么药」强得多:是「**两小时前静脉输了什么**」。因此:

- `administered_at` 必须精确到分,不能只有日期
- 趋势图上输液事件需与检验时间点**对齐显示**
- 情境问答新增「这次有没有输液/打针?」;若同一 encounter 内已识别到输液单,**自动关联,不必问**

#### ⚠️ 药物剂量是另一套单位体系

同一张单上并存**体积**(mL)、**质量**(mg / g 混用)、**浓度**(%)。`0.15 克 = 150 毫克`;浓度 × 体积可算实际溶质量(10% 氯化钠 10 mL = 1 g NaCl)。

`packages/medical/src/units/` 只处理检验单位 → **需要独立的 `units/dose` 模块**,两套体系不可混用。

#### 提取要求

- **`name_raw` 存原文,`generic_name` 剥离采购信息。** 真实药名形如 `5%葡萄糖注射液(科伦250ml,23年集采)`、`15%氯化钾注射液(25年国采)` —— 括号里的厂家与集采批次对长期用药记录无价值,且会污染药名匹配
- **`frequency_raw` 不做归一化解析。** 中英混排(`静滴 ONCE 1天`)的解析风险高、收益低,原文保留 + 可选打标签
- **费用信息记录但不建模。** 输液单上有收费明细,存入 `extraction.structured` 即可,不建费用表 —— 除非明确需要报销/支出统计功能
- **护士签名等执行凭证只记有无**,存 `extraction.structured`,不建列(fixture 003 回填)

### `metric_group` / `metric_group_item`

用户自定义的长期监控组(如"三高")。预置模板见 [08 · 医学参考层](./08-medical-reference.md#5-推荐监控组)。定义与每次修改以 `metric_group_upsert` 事件双写 journal(ADR-045)—— 用户自建监控组不可再生。

```
metric_group      (id, person_id, name, description, is_template, created_at)
metric_group_item (group_id, item_type, concept_code, body_site, conclusion_tag,
                   display_order, note)
```

`item_type` 支持三类条目 —— **监控组不能只绑化验指标**:

| `item_type` | 绑定 | 例 |
|---|---|---|
| `lab` | `concept_code` | LDL_C、HbA1c |
| `imaging_measure` | `concept_code` + `body_site` | 睾丸体积(左)、甲状腺结节最大径 |
| `conclusion` | `conclusion_tag` | 「鞘膜积液」出现/未出现于历次影像结论 |

> 真实案例:一次为查腹泻开的腹部超声,**顺带扫了阴囊**,产生了鞘膜积液的随访数据。这正是本项目的核心场景 ——「每次检查不一定针对该问题,但顺带查到的值应能纳入长期记录」。若监控组只能绑化验指标,这条路径就断了。

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

> 落点(ADR-045):人工动作类审计已随 journal 双写,不重复记;系统级事件(权限授予/撤销、文档删除)追加导出 `_index/audit/{YYYY-MM}.jsonl`。

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
CREATE UNIQUE INDEX ON observation (document_id, concept_code, series_key);  -- ADR-042

-- 待处理队列
CREATE INDEX ON document (status) WHERE status <> 'ready';
CREATE INDEX ON observation (review_status) WHERE review_status = 'unreviewed';

-- 每个 document 至多一个 active extraction
CREATE UNIQUE INDEX ON extraction (document_id) WHERE is_active;

-- 全文与语义
CREATE INDEX ON extraction USING gin (full_text gin_trgm_ops);
CREATE INDEX ON extraction USING ivfflat (full_text_embedding vector_cosine_ops);

-- 归一化决策缓存(同指纹同决策)
CREATE UNIQUE INDEX ON normalization_decision (decision_type, fingerprint)
  WHERE status IN ('proposed', 'confirmed');
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
