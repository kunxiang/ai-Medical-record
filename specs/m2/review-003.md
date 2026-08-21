# M2 Spec 审核 #003

> **⚠️ 独立性声明(必须先读)**
> docs/10 §1 要求"≥2 个独立对抗视角"。**本轮不满足该要求** —— 本会话配置禁止在未获用户请求时启用子代理,因此这轮由 spec 作者本人以两个对抗视角逐条复核。
> 作者复核能抓到**内部矛盾、事实错误、不可测断言**(下方 A1–A5 即属此类,且都是硬伤),但对**"我压根没想到的角度"**天然失效。
> 处置:本轮结论按 A/B/C 分档并已回写 spec;**建议**在实现开工前补一轮真正独立的审核。是否补由项目所有者决定。

审核视角:
- **视角一 · 实现者**:拿着 spec 写代码,哪一条会让我卡住、猜、或写出跑不起来的东西?
- **视角二 · 重建者**:删库之后,凭桶里的东西能不能把 M2 产生的一切复原?哪条会让我复原不出来?

---

## A 档(开工前必须修 spec)

### A1 · `messages.parse()` 与 `fallbacks` 不能这样组合 【视角一】

`02 §2` 的调用示例把 `client.messages.parse()` 与 `betas` + `fallbacks` 写在同一个请求里。核实:`messages.parse()` 位于**非 beta** 命名空间且不接受 `betas`;`fallbacks` 必须走 `client.beta.messages.create` + `betas`。实现者照抄必然失败。

**裁决:改用 `client.beta.messages.create` + `output_config.format`(值由 `zodOutputFormat(Stage1Out)` 生成)+ 调用方自行 `Stage1Out.parse()` 校验。** 放弃 `parsed_output` 便利,换取与 `fallbacks` 共存。校验失败按 `02 §5.4` 的"输出未通过 Zod 校验"路径处理 —— 该路径本就已定义,无需新增。

### A2 · `sampled_on` 是 `date`,却要用它做 ±12 小时时间窗 【视角一】

`05 §3.1` 规定 `event_time` 取 `sampled_on` → `reported_on` → `capture_date`,并按 **±12 小时**归组。但 `01 §5` 把 `sampled_on`/`reported_on` 定义为 `date` 类型 —— **日期没有时分**,对它做 12 小时窗口是无意义的,且恰好退化成 ADR-037 明令禁止的"按日历日归组"。

**裁决:**
1. `sampled_on` / `reported_on` 保持 `date`(报告上通常确实只印日期)。
2. 新增 `document.event_at timestamptz`(可空):S1 若能读出时分则填,否则为 null。
3. 归组的 `event_time` 定义改为:`event_at` 优先;**两侧都缺 `event_at` 时,退化为同日历日 + 相邻日的 `capture_date` 比较,并必须把 `event_time_source` 记为 `capture_date_degraded`**,在 UI 上标注该组的判据较弱。
4. `EventTimeSource` 枚举增加 `event_at` 与 `capture_date_degraded` 两个值。

> 不能假装有时分。ADR-037 的实证(急诊 05:09、23:50 挂号次日 00:30 抽血)恰恰说明:**没有时分时,归组就是不可靠的,必须如实标注,而不是用日期硬算出一个假的 12 小时窗。**

### A3 · A28 的 L1 零字节断言与 A12/A13/A20 直接冲突 【视角二】

`99 A28` 要求 A 组全程 `people/**` 的 (Key,VersionId,ETag) 逐字节不变。但同组的 A12(`person_check_ack` 写 journal)、A13(写 `correction-0001.json`)、A20(写 `document_archive` journal)**都在 `people/**` 下新增对象**。该断言必然失败。

> 这是 M1 验收 A17 踩过的同一个坑的复发(当时是 A8 的 discard 写 journal 撞上基线)。**同类缺陷第二次出现,说明"L1 零字节"这条断言的表述方式本身有问题** —— 它把"不可变"和"不新增"混为一谈。

**裁决:拆成两条,语义分开。**
- **A28a · L1 既有对象不可变**:基线只取 `原件 page-NN.*`、`capture.json`、`page-NN.json` 三类 key 的 (Key,VersionId,ETag);A 组结束时逐字节相同。**追加类对象(journal / manifests / correction-NNNN.json)不进基线。**
- **A28b · L1 只增不改**:A 组结束时,`people/**` 下的对象集合相对基线**只允许新增**;任何既有 key 出现新版本即失败(追加类对象也不许被覆盖 —— 它们是 `If-None-Match: *` 仅创建写的)。

### A4 · D7 的 split/merge/move-page 没有重建故事 【视角二】

`06 §3` 规定原件不动、以 `correction-NNNN.json` + manifests 记录。但 `rebuild-index` 现行逻辑是:**逐个文档目录读 `capture.json` 重建 document 与 pages**。一个被移走的页,重建时会被原样恢复到**原文档**里 —— 拆分、合并、移页在删库重建后**全部丢失**。

而 manifests 现有语义(ADR-041 §4)只覆盖 `add` 与"同 `doc_short_id` 后写覆盖先写"的归人纠正,**不表达页级归属**。

**裁决:**
1. `correction-NNNN.json` 的 `kind` 扩展为 `person_reassign | page_move`(拆分与合并均可分解为一组 `page_move`)。
2. `page_move` 修正的载荷必须含 `{ seq, from_doc_short_id, to_doc_short_id, page_sha256, from_page_no, to_page_no }`。**用 `page_sha256` 而非 key 定位页** —— key 里的 `NN` 是拍摄序且永不改名(ADR-047),移页之后 key 与所属文档不再对应,只有内容摘要是稳定锚点。
3. `rebuild-index` 的重放顺序**必须**是:①按 manifests 建文档骨架 → ②读各目录 `capture.json` 恢复页 → ③**扫描全部 `correction-*.json`,按 `(created_at, seq)` 全局排序后重放 `page_move`**。
4. 目标文档若在重放时尚不存在(拆分产生的新文档),**必须**由 `page_move` 的 `to_doc_short_id` 触发建档;该新文档没有自己的 `capture.json`,其 `person_id` 由 manifests 的对应 `add` 行提供 —— 因此 **split 必须同时向 manifests 追加新文档的 `add` 行**。
5. `99` 增断言 A21b:拆分后删库重建 → 拆分结果原样复原。

> 没有这条,D7 就是一个"能用但重建后消失"的功能 —— 而 ADR-045 的整个立论就是 L1 必须能独立重建出全部人工判断。

### A5 · `encounter_suggest` 作业没有去重键 【视角一】

`04 §2` 的唯一索引是 `(document_id, kind) WHERE document_id IS NOT NULL`。而 `encounter_suggest` 是跨文档的,`document_id` 为 null ⇒ **不受该索引约束**,重复投递会无限累积。

**裁决:** `ai_job` 增列 `dedup_key text`,唯一索引改为 `UNIQUE (dedup_key)`;`stage1` 的 `dedup_key = 'stage1:' || document_id`,`facility_normalize` 的 `= 'facility:' || input_fingerprint`,`encounter_suggest` 的 `= 'encounter:' || person_id || ':' || date_trunc('day', event_time)`。原 `(document_id, kind)` 索引删除。

### A6 · 归人对账的 `name_pinyin` 用法未定义 【视角一】

`05 §1.1` 说比对 `display_name` **及** `name_pinyin`,`§1.3` 的规则里却只字未提 pinyin。实现者只能猜。

**裁决:** 规则改为:归一后 `patient_name` 与 `display_name` 相等 → `match`;否则若 `name_pinyin` 非空且 `patient_name` 归一后等于 `name_pinyin` → `match`;`patient_name` 为 null → `unknown`;其余 → `mismatch`。**仍然禁止任何相似度阈值。**

### A7 · 分批时的页号是全局还是批内,未定义 【视角一】

`02 §3.4` 要求每张图前插 `第 N 页:`,`03 §5` 的合并规则按 `page_no` 拼接并要求冲突即失败。若 N 是批内序号,第二批会重复产出 1..5,与全局页号冲突 ⇒ 合并必然失败。

**裁决:** N **必须**是**全局** `page_no`;prompt 中须显式说明"页号已给出,直接采用,不要自行编号"。`03 §5` 增一条:合并前校验每批返回的 `page_no` 集合与该批送入的集合相等,不等即 `needs_human`。

### A8 · B2 的 CI 断言会被录制盒误伤 【视角一】

`99 B2` 要求全仓无内联 `claude-` 字面量。而 `§0.2` 要求把录制盒提交进仓库,盒内必然含 `"model": "claude-opus-5"`。断言必红。

**裁决:** B2 的扫描范围排除 `fixtures/**` 与 `docs/**`,只扫 `packages/**/src`、`apps/**/src`、`tools/src`。

---

## B 档(实现注记,不改 spec 结论)

| # | 事项 | 注记 |
|---|---|---|
| B1 | `03 §6` 禁止 `full_text` 入库,但 `summary` 是入库的,模型可能把手机号写进 `summary` | prompt 须显式禁止在 `summary` 与任何结构化字段中复述丢弃类 PII;`99 A9` 的断言范围已覆盖(它扫的是"任何 DB 列") |
| B2 | PDF 走 `document` 块时页粒度不可控 | 实现时先整份提交,若模型返回的 `pages[].page_no` 与 `document_page` 行数不符,记 `needs_human`,不猜 |
| B3 | `99 A3` 的"回滚登记事务后 job 行不存在"不可测 | 改为白盒单测:在 `POST /documents` 的事务内注入抛错,断言 `ai_job` 无新行 |
| B4 | 归人纠正后旧 `derived/{old_slug}/**` 成为孤儿,无清理规则 | M2 不清理(L2 可丢、成本极低);登记为 C 档设计债 |
| B5 | `02 §1` 超时 600000 ms 与 `max_tokens: 16000` 非流式 | 16000 在非流式推荐范围内;若实测触发超时,改流式 + `finalMessage()`,不要调低 `max_tokens` |

---

## C 档(登记设计债)

| # | 内容 | 绑定 |
|---|---|---|
| C1 | 归人纠正 / 移页后 `derived/` 下的孤儿派生物无清理机制 | D19,M4(随检索 UI 一并处理 L2 生命周期) |
| C2 | `99 C` 组依赖项目所有者提供 ≥20 份真实单据并完成 PII 剥除 | 非技术阻塞;C 组在此之前无法运行,A/B 组不受影响 |

---

## 统计

A 档 8 项 · B 档 5 项 · C 档 2 项。
A 档中 A2/A3/A4 三项属**会在验收时才炸、且炸得很晚**的类型(时间窗退化、断言自相矛盾、重建丢数据),提前捞出的收益最高。
