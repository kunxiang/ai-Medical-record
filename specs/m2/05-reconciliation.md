# M2 Spec · 05 归人对账 / facility 归一 / encounter 归组建议

三者共享同一条纪律(ADR-040):**判断可以是 AI,执行必须是确定性代码,判断本身必须持久化且可人工确认。**

## 1. 归人对账(ADR-041)

归人已在拍摄现场由人完成(M1,`confirmed_by='capture_ui'`)。S1 读出的姓名只用于**对账**。

1. S1 完成后 **必须**执行确定性比对:`Stage1Out.patient_name` 与 `person.display_name`(及 `person.name_pinyin`)。
2. **禁止**因比对结果修改 `document.person_id`。一次也不行。**归人从不静默默认**是本里程碑的验收句之一。
3. 比对规则(确定性,**禁止**再调 AI;审核 #003 A6 补全 pinyin 用法):
   - 两侧先做 NFKC 归一 + 去除空白与常见分隔符,记为 `norm()`;
   - `norm(patient_name) === norm(display_name)` → `match`;
   - 否则,`name_pinyin` 非空 **且** `norm(patient_name) === norm(name_pinyin)` → `match`;
   - `patient_name` 为 null → `unknown`;
   - 其余一律 → `mismatch`。
   > **禁止**引入模糊匹配阈值。"张伟" vs "张玮" 的相似度很高但是两个人;把这种判断交给阈值,等于用一个不可解释的数字决定病历归谁。
4. `mismatch` 与 `unknown` **必须**写入 `document.person_check`(新列,枚举 `match|mismatch|unknown|skipped`),并**必须**在 `GET /documents` 列表项中返回,使 UI 能显示告警条。
5. `mismatch` **必须**进人工队列(`GET /jobs?state=needs_human` 之外另设 `GET /documents?person_check=mismatch`)。
6. 人工处置只有两个出口,**都属人的判断,都必须双写 journal**:
   - **确认无误**(如报告上是家长姓名、孩子是被检人)→ `person_check := 'skipped'`,journal 事件 `person_check_ack`。
   - **确实归错**→ 走 [06](./06-corrections.md) §2 的归人纠正,journal 事件 `person_reassign`。

## 2. facility 归一(ADR-040)

1. S1 只产出 `facility_name_raw`(报告上的原文)。**禁止** S1 直接产出 `facility_id`。
2. 归一分三层:
   - **判断层**:输入指纹 = `sha256(canonical({ raw_name, city_hint? }))`。先查 `normalization_decision`;命中则**直接复用**,**禁止**再调 AI(同输入指纹 → 同决策,确定性重放)。
   - **执行层**:按决策写 `document.facility_id`,必要时 `INSERT` 新 `facility` 行。**必须**是确定性代码。
   - **决策层**:未命中时调用 AI 产出候选,写入 `normalization_decision`(`state='proposed'`)。
3. `normalization_decision` 表 **必须**包含:`id`、`kind`(`'facility'`)、`input_fingerprint`(唯一)、`proposal` jsonb、`state`(`proposed|confirmed|rejected`)、`decided_by`、`decided_at`、`prompt_id`/`prompt_version`/`model`。
4. `state='proposed'` 的决策 **必须**先落 `facility_id`(以免文档没有机构可用),同时在 UI 标注"待确认"。人工确认或否决 **必须**双写 journal(事件 `normalization_confirm`)。
5. 词表/注册表快照 **必须**随 `_meta/registries/` 落桶(ADR-045 对 ADR-040 的修订)——否则决策离开代码仓库不可解读。

## 3. encounter 归组建议(ADR-037)

1. 候选条件(**确定性预筛**,不调 AI):同 `person_id` **且** 同 `facility_id` **且** 两文档的 `event_time` 满足下列之一。
2. `event_time` 的取值与判据(审核 #003 A2):

| 情形 | `event_time_source` | 判据 |
|---|---|---|
| 两侧 `document.event_at` 均非空 | `event_at` | 差 ≤ **12 小时** |
| 仅一侧有 `event_at` | `event_at` | 另一侧用其 `sampled_on`/`reported_on` 的**当日 00:00–24:00 全区间**与之求交,有交集则为候选 |
| 两侧都无 `event_at` | `capture_date_degraded` | `sampled_on`(缺则 `reported_on`,再缺则 `capture_date`)相同或**相邻一日**;该组**必须**在 UI 标注"判据较弱" |

   > **不能假装有时分。** `sampled_on`/`reported_on` 是 `date` 类型 —— 报告上通常确实只印日期。对一个没有时分的字段做 ±12 小时窗口,算出来的是假精度,而且恰好退化成 ADR-037 明令禁止的按日历日归组。老老实实降级并**如实标注判据强度**,比算一个看起来精确的假窗口诚实。
   > `document.event_at timestamptz`(可空)由 S1 在报告确实印有时分时填写,否则为 null。

3. **禁止**在两侧都无 `event_at` 时使用 ±12 小时表述。凌晨跨日的就诊(ADR-037 实证:急诊 05:09、23:50 挂号次日 00:30 抽血)由"相邻一日"覆盖。
4. 预筛出的候选组 **必须**交 AI 判断"是否同一次就诊",产出 `proposal`;写入 `normalization_decision`(`kind='encounter'`)。
5. **M2 只产出建议,禁止自动建 `encounter` 行。** 人工确认后才落库,并双写 journal(事件 `encounter_confirm`)。
6. 采样事件(同一次就诊内的多次采样)**不建表**(ADR-037),M2 不实现。

## 4. 三者的共同约束

1. 任何 AI 判断的结果 **禁止**直接成为不可追溯的既成事实:`normalization_decision` 里 **必须**能查到是哪个 `prompt_version` + 哪个 `model` 产生的。
2. 人工确认/否决 **必须**双写 journal;AI 提议 **禁止**写 journal。
3. 删库重建后:`normalization_decision` 的 `confirmed` 行 **必须**能从 journal 回放恢复(它们是人的判断);`proposed` 行**可以**丢失并由重跑再生。
   > 这条直接决定了 journal 事件的取舍:**确认写 journal,提议不写。**
