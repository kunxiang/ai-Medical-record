# M2 Spec · 07 人工层回放(D16 最小切片)

> 本文件因审核 #004 A-1 / A-14 新增。原版 spec 规范性地断言"confirmed 行**必须**能从 journal 回放恢复",
> 而 `rebuild-index` 至今**一行 journal 都不读**,D16 又把回放绑在 M3 —— 规范说能、实现不能、验收不查。

## 1. 为什么把 D16 的绑定从 M3 上调到 M2

D16 当初绑 M3,理由是「M3 的问答答案是第一个必须回放到 DB 的人工层事件」。**M2 证明这个判断是错的**:M2 新增了五类人的判断,其中四类必须回放 ——

| 人工判断 | 不回放的后果 |
|---|---|
| 软删除(`document_archive`) | 已归档的废片**全部复活**,且按 [04](./04-jobs.md) §2.2 会被**重新投递作业、重新付费调模型** |
| 归人告警确认(`person_check_ack`) | 告警重现;对"报告印家长姓名"这类**永久不可能匹配**的情形,用户每次重建后都要重新 ack 一遍 |
| 归一/归组确认(`normalization_confirm`) | 确认作废,须重新调 AI 并重新人工确认;`facility` 表本身也不在任何 L1 对象里 |
| 文档边界组装(`document_split` 等) | 见 [06](./06-corrections.md) §3,由 correction 承载,不依赖 journal |

D1 的验收标准是「每个里程碑的恢复演练:该里程碑新增人工输入**零丢失**」,且 design-debt 表头写明「到期未清不得进入下一里程碑」。**债的绑定跟着事实走,不跟着当初的猜测走。**

M2 只做**最小切片**:三个事件的 DB 落点回放。问答答案、person 编辑历史等仍留 M3。

## 2. `rebuild-index` 新增第 4 步

现行三步不变(manifests 建骨架 → `capture.json` 恢复页 → `_person.json` 恢复人)。新增:

```
④ 人工层回放
   ├─ 扫描 people/*/journal/{YYYY}-{MM}.jsonl        → 逐行
   ├─ 扫描 _index/decisions/{YYYY}-{MM}.jsonl        → 逐行
   ├─ 按 (at, event_id) 全局排序                      ← 见 §3
   └─ 逐条重放,event_id 幂等
⑤ correction 重放(见 06 §3)
   └─ 按 (corrected_at, from_doc_short_id, seq) 排序,重放 page_move
```

1. 第 ④ 步 **必须**在第 ③ 步之后、第 ⑤ 步之前。理由:`person_check_ack` 引用 `document_short_id`,文档骨架必须先在。
2. **`event_id` 幂等**:已见过的 `event_id` 直接跳过,与 manifests 的既有做法同构。
3. **未知事件类型**:记入对账报告并**继续**,**禁止**中断整个重建。
   > 理由:一个 M3 才认识的事件出现在 M2 的重建里是**正常**的(用户从更新的版本回滚),把它当致命错误会让重建工具变成版本锁。

## 3. 排序键与时钟

1. 排序键为 **`(at, event_id)`**。`at` 是服务端时间戳(`serverTimestamp()`),`event_id` 是 uuid v7 —— 二者都单调,`event_id` 作为次键给出确定性 tiebreak。
2. **禁止**使用 S3 对象的 `LastModified` 作为任何排序依据(不确定、可被复制改变)。
3. 跨文件排序:一个月内的 journal 与 decisions 是两个对象,**必须**先全部读入再统一排序,**禁止**按文件顺序逐个重放。

## 4. 三个事件的 DB 落点

| 事件 | 落点 | 幂等语义 |
|---|---|---|
| `document_archive` | `document.archived_at := archived ? at : NULL` | 同 `document_short_id` 的多条按 `at` 顺序重放,**最后写入者胜** |
| `person_check_ack` | `document.person_check_ack_at := at` | 同上;`archived=false` 的撤销归档同理 |
| `normalization_confirm` | `normalization_decision`:按 `input_fingerprint` upsert,`state := decision`,并**执行**该决策(见 §5) | 同 `input_fingerprint` 的多条按 `at` 顺序重放,最后写入者胜 |

1. 重放 **禁止**触发任何 AI 调用、**禁止**投递任何 `ai_job`。
2. 重放 **禁止**写 journal 或 decisions(否则每次重建都会让文件长一倍)。

## 5. `normalization_confirm` 的执行层重放

确认一条 facility 归一,不只是把 `normalization_decision` 置 `confirmed` —— 它还有执行层后果:`facility` 行与 `document.facility_id`。而 `facility` 表**不在任何 L1 对象里**,删库即消失。

**因此 `normalization_confirm` 的载荷 `payload` 必须自带重建 `facility` 行所需的全部事实**:

```jsonc
{ "op": "normalization_confirm", "kind": "facility",
  "input_fingerprint": "…", "decision": "confirmed",
  "payload": {
    "facility": { "slug": "f7k2m9", "name": "北京协和医院", "city": "北京", "level": "三甲" },
    "matched_raw_names": ["北京协和医院", "协和医院(东单院区)"]
  } }
```

重放时:①按 `slug` upsert `facility` 行;②把 `matched_raw_names` 追加进 `facility.aliases`(去重);③**不**回填 `document.facility_id` —— 那是 L2,由 [05](./05-reconciliation.md) §2.2 的执行层在 S1 重跑时按指纹回填。

> 这条分界很关键:**`facility` 这张"词表"是人的判断,必须回放;哪份文档指向哪家机构是可重算的,不必回放。**

## 6. 与"rebuild 不理解 AI 语义"的关系(审核 #004 B-7)

`docs/04 §3` 写明「重建时由 L2 自己重算,**rebuild 工具不需要理解任何 AI 语义**」。第 ④ 步**不违反**这条:

- 它读的是**人的确认结果**(`_index/decisions/` 是 L1、打包必带),不是 AI 的提议;
- 它**不**读 `derived/**/extractions/` 的任何工件,**不**解析 `Stage1Out`。

原版 `03 §6.3` 要求 rebuild 打开 S1 工件回填 `doc_type` 等列 —— **该要求已删除**。理由是审核 #004 B-7 给出的:按 `docs/04 §7` 的恢复剧本,冷备里**根本没有 `derived/`**(rclone 只同步 `people _index _meta`),这段代码在真实恢复时 100% 走 else 分支。于是演练(桶完好)与真实恢复(桶只有 L1)结果不同 —— 而「没演练过的备份等于没有备份」这套逻辑建立在**演练能代表真实恢复**之上。

L2 列的恢复由 [04](./04-jobs.md) §2.2 既有的"为缺 `s1_artifact_key` 的文档重新投递 `stage1`"承担。若要省重跑成本,**可以**另做一个 `tools/` 下的独立 L2 补水脚本,**禁止**塞进 rebuild。

## 7. 验收

见 [99](./99-acceptance.md) A33–A35。核心一条:**归档 + ack + 归一确认三者做完 → 删库重建 → 三者原样复原**,且重建过程**零 AI 调用**(回放 transport 计数为 0)。
