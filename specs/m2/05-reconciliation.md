# M2 Spec · 05 归人对账 / facility 归一 / encounter 归组建议

三者共享同一条纪律(ADR-040):**判断可以是 AI,执行必须是确定性代码,判断本身必须持久化且可人工确认。**

## 1. 归人对账(ADR-041)

归人已在拍摄现场由人完成(M1,`confirmed_by='capture_ui'`)。S1 读出的姓名只用于**对账**。

1. S1 完成后 **必须**执行确定性比对:`Stage1Out.patient_name` 与 `person.display_name`(及 `person.name_pinyin`)。
2. **禁止**因比对结果修改 `document.person_id`。一次也不行。**归人从不静默默认**是本里程碑的验收句之一。
3. 比对规则(确定性,**禁止**再调 AI;审核 #003 A6 补全 pinyin,#004 B-1 定死 `norm()`):

   `norm(s)` **必须**精确定义为(常量放 `packages/contracts`,配单测):
   ① NFKC 归一 → ② `toLowerCase()` → ③ 删除全部 `\p{White_Space}` → ④ 删除下列**逐字列出**的分隔符集合:
   `· ‧ • ・ . 。 , , 、 - ‐ ‑ ‒ – — _ / \`
   > "去除常见分隔符"是散文不是字母表。折不折叠大小写,直接决定 `ZHANG WEI` vs `Zhang Wei` 是否 mismatch;
   > `·` 收不收,直接决定 `阿依古丽·买买提` vs `阿依古丽买买提` 的归属。A10/A11 用的是"完全相同/完全不同"的用例,
   > 两种实现都能过,缺陷会带着上线(审核 #004 B-1)。

   - `norm(patient_name) === norm(display_name)` → `match`;
   - 否则,`name_pinyin` 非空 **且** `norm(patient_name) === norm(name_pinyin)` → `match`;
   - `patient_name` 为 null → `unknown`;
   - 其余一律 → `mismatch`。
   > **禁止**引入模糊匹配阈值。"张伟" vs "张玮" 的相似度很高但是两个人;把这种判断交给阈值,等于用一个不可解释的数字决定病历归谁。
4. 比对结果写入 `document.person_check`(枚举 `match|mismatch|unknown`,**无 `skipped`**)。
5. **★ 比对禁止写入或清除任何 L1 人工层列**(审核 #004 A-5)。`person_check` 是 L2,每次 S1 重跑都会被覆盖;
   人工 ack 写的是 `document.person_check_ack_at`(L1)。
   > 原设计让 ack 把 `person_check` 置 `skipped` —— 而 A27 那条验收步骤本身("删光 derived 与 ai_job → 重跑")
   > 就会把它抹掉。对"报告印家长姓名、被检人是孩子"这类**永久不可能匹配**的情形,用户将被迫每次模型升级后
   > 重新 ack 全家所有此类文档。这直接违反 [00](./00-scope.md) §4.4 的分界线:一列同时承载模型与人的判断,
   > 而重跑时模型赢。
6. **告警条件恒为 `person_check='mismatch' AND person_check_ack_at IS NULL`**,`GET /documents` **必须**下发两列。
7. `mismatch` 且未 ack 的**必须**可一次列出(`GET /documents?person_check=mismatch&acked=false`)。
8. 人工处置只有两个出口,**都属人的判断,都必须双写 journal**:
   - **确认无误** → `person_check_ack_at := now()`,journal 事件 `person_check_ack`(载荷含 `observed_name` / `expected_name` 快照,见 [01](./01-contracts-delta.md) §4.1)。
   - **确实归错** → 走 [06](./06-corrections.md) §2 的归人纠正,journal 事件 `person_reassign`。

## 2. facility 归一(ADR-040)

1. S1 只产出 `facility_name_raw`(报告上的原文)。**禁止** S1 直接产出 `facility_id`。
2. 归一分三层:
   - **判断层**:输入指纹 = `sha256(canonical({ raw_name: norm(facility_name_raw) }))`。先查 `normalization_decision`;命中则**直接复用**,**禁止**再调 AI(同输入指纹 → 同决策,确定性重放)。
     > **删掉了原版的 `city_hint`**(审核 #004 B-2):它在 M2 没有可靠来源 —— S1 输出里没有城市,`facility.city` 要等归一之后才有。
     > 而 `canonical()` 对"键缺省"与"键为 null"产出的字节不同 ⇒ 同一家医院两次指纹不同 ⇒ 决策缓存失效 ⇒ A16 随机失败。
   - **执行层**:**必须回填全部** `facility_name_raw` 指纹相同且 `facility_id` 为空的文档,**不是**只写触发文档(审核 #004 A-7)。
     > 否则:用户一次扫同院 5 份单据,第 1 份投递作业成功、第 2–5 份被 `DO NOTHING` 静默丢弃,
     > 那条唯一作业完成后只写一个文档 ⇒ 第 2–5 份的 `facility_id` 永远为空且**无任何信号**,
     > 违反 [04](./04-jobs.md) §5 自己写的"禁止任何'失败就静默跳过'的路径"。
     必要时 `INSERT` 新 `facility` 行:`slug = 'f' + 5 × A`(复用 m0-03 §1 的字母表与 CSPRNG);
     `aliases` 由执行层追加 `facility_name_raw`(去重)。**必须**是确定性代码。
   - **决策层**:未命中时调用 AI 产出候选,写入 `normalization_decision`(`state='proposed'`)。
3. `normalization_decision` 表 **必须**包含:`id`、`kind`(`'facility'`)、`input_fingerprint`(唯一)、`proposal` jsonb、`state`(`proposed|confirmed|rejected`)、`decided_by`、`decided_at`、`prompt_id`/`prompt_version`/`model`。
4. `state='proposed'` 的决策 **必须**先落 `facility_id`(以免文档没有机构可用),同时在 UI 标注"待确认"。
5. 人工确认或否决 **必须**追加 **`_index/decisions/{YYYY}-{MM}.jsonl`**(op `normalization_confirm`),**不写 per-person journal**(审核 #004 A-2)。
   > facility 归一是**全家共享词表**(`docs/04 §1` 矩阵第 7 行、ADR-040),不属于任何一个 person。而 `appendJournal` 的
   > `personSlug` 是必填的 —— 硬塞进"碰巧触发这次归一的那份文档的归属人",会让家庭共享词表被随机切碎散落进 N 个人的 journal:
   > 单人导出时孩子拿到父母档案触发的机构决策,或反过来自己缺词表。
6. 该决策的载荷**必须自带重建 `facility` 行所需的全部事实**(见 [07](./07-replay.md) §5)—— `facility` 表不在任何 L1 对象里,删库即消失。
7. 词表/注册表快照 **必须**随 `_meta/registries/` 落桶(ADR-045 对 ADR-040 的修订)——否则决策离开代码仓库不可解读。

## 3. encounter 归组建议(ADR-037)

1. 候选条件(**确定性预筛**,不调 AI):同 `person_id` **且** 同 `facility_id` **且** 两文档的 `event_time` 满足下列之一。
2. `event_time` 的取值与判据(审核 #003 A2):

| 情形 | `encounter.grouping_basis` | 判据 |
|---|---|---|
| 两侧 `document.event_time` 均非空 | `event_time` | 差 ≤ **12 小时** |
| 仅一侧有 `event_time` | `event_time` | 另一侧用其 `sampled_on`/`reported_on` 的**当日 00:00–24:00 全区间**与之求交,有交集则为候选 |
| 两侧都无 `event_time` | `capture_date_degraded` | `sampled_on`(缺则 `reported_on`,再缺则 `capture_date`)相同或**相邻一日**;该组**必须**在 UI 标注"判据较弱" |

   > **不能假装有时分。** `sampled_on`/`reported_on` 是 `date` 类型 —— 报告上通常确实只印日期。对一个没有时分的字段做 ±12 小时窗口,算出来的是假精度,而且恰好退化成 ADR-037 明令禁止的按日历日归组。老老实实降级并**如实标注判据强度**,比算一个看起来精确的假窗口诚实。
   >
   > **复用 M0 既有的 `document.event_time`,禁止新造 `event_at`**(审核 #004 A-5′):该列在 M0 就已建出(注释"AI/提取相关列:M0 建出恒 NULL"),
   > 由 S1 在报告确实印有时分时填写。判据强度记在 **`encounter.grouping_basis`** 上,不记在 `document` 上 ——
   > `document.event_time_source` 有它自己的取值域(`docs/03 §226`:该时刻取自哪个字段),两件事不能挤在一个列名里。

3. **禁止**在两侧都无 `event_time` 时使用 ±12 小时表述。凌晨跨日的就诊(ADR-037 实证:急诊 05:09、23:50 挂号次日 00:30 抽血)由"相邻一日"覆盖。
4. **一次 `encounter_suggest` 作业的候选集 = 该 `person_id` 的全部未归组文档**(审核 #004 A-6)。
   作业是 person 级合并型的(`dedup_key = 'encounter:' || person_id`,冲突时 `DO UPDATE` 刷新 `next_attempt_at`),
   **不按日历日切分** —— 按日历日切分会与本节"禁止按日历日"的判据自相矛盾,且 23:50 / 次日 00:30 那一对会落进两条不同作业,
   谁负责评估它都说不清。
5. 预筛出的候选组 **必须**交 AI 判断"是否同一次就诊",产出 `proposal`;写入 `normalization_decision`(`kind='encounter'`)。
6. **M2 只产出建议,禁止自动建 `encounter` 行。** 人工确认后才落库,并追加 `_index/decisions/`(op `normalization_confirm`,`kind='encounter'`)——**不要 `encounter_confirm` 这个名字**(审核 #004 A-1:它会成为第 8 个事件,与 01 §4 的注册表和 B5 的计数冲突)。确认时**必须**写 `encounter.grouping_basis`。
7. 采样事件(同一次就诊内的多次采样)**不建表**(ADR-037),M2 不实现。

## 4. 三者的共同约束

1. 任何 AI 判断的结果 **禁止**直接成为不可追溯的既成事实:`normalization_decision` 里 **必须**能查到是哪个 `prompt_version` + 哪个 `model` 产生的。
2. 人工确认/否决 **必须**双写 journal;AI 提议 **禁止**写 journal。
3. 删库重建后:`normalization_decision` 的 `confirmed` 行 **必须**能从 **`_index/decisions/`** 回放恢复(它们是人的判断);`proposed` 行**可以**丢失并由重跑再生。
   > 这条直接决定了落桶的取舍:**确认写 decisions,提议不写。** 回放的规范见 [07](./07-replay.md) —— 它是 M2 的交付物,不是 M3 的。
