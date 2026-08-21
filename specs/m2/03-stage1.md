# M2 Spec · 03 Stage 1:分类 + 元数据 + 全文提取

一次调用同时产出:文档类型、人、日期、机构、科室、**完整文本**。
**全文是这一步最重要的产出** —— 结构化提取会失败,全文不会。

## 1. 输出 schema

定义于 `packages/contracts/src/ai.ts`,由 `packages/ai` 引用(单一出处,**禁止**在 prompt 文件或调用点重复维护枚举)。

```ts
export const Stage1Page = z.object({
  page_no: z.number().int().min(1),
  page_label: z.string().nullable(),      // 页脚原文,如 "第 1 页,共 2 页"
  page_index: z.number().int().nullable(),// 从 page_label 解析出的页序
  page_total: z.number().int().nullable(),
  full_text: z.string(),                  // 该页完整文本,保留原始换行与表格结构
}).strict();

export const Stage1Out = z.object({
  doc_type: DocType,                      // 从 contracts 的 DocType 导出
  doc_type_confidence: z.number().min(0).max(1),
  patient_name: z.string().nullable(),
  patient_sex: z.enum(['male','female','unknown']).nullable(),
  patient_age_text: z.string().nullable(),
  patient_identifiers: z.array(z.object({ type: z.string(), value: z.string() }).strict()),
  facility_name_raw: z.string().nullable(),
  department_raw: z.string().nullable(),
  sampled_on: IsoDate.nullable(),
  reported_on: IsoDate.nullable(),
  summary: z.string(),                    // 一句话:这是什么单子
  pages: z.array(Stage1Page).min(1),
  pii_spans: z.array(z.object({
    page_no: z.number().int().min(1),
    kind: PiiKind, start: z.number().int(), end: z.number().int(),
  }).strict()),
  boundary_hint: z.object({               // D7 文档边界建议
    likely_same_document: z.boolean(),
    reason: z.string(),
  }).strict().nullable(),
  unmodeled: z.array(z.object({           // 残差通道,ADR-043
    label: z.string(), value: z.string(), page_no: z.number().int(),
  }).strict()),
}).strict();
```

规范性条文:

1. 全部对象 **必须** `.strict()`。未知键即失败 —— 与 M0/M1 的 sidecar 同一纪律。
2. `doc_type` **必须**引用 contracts 既有的 `DocType` 枚举,**禁止**在此另立清单。
3. 日期 **必须**为 `YYYY-MM-DD`;解析失败 **必须**置 `null`,**禁止**猜测。
4. `full_text` **必须**逐页产出,**禁止**跨页拼接为单一字符串 —— 跨页拼接会让 D7 的边界建议与页级重跑失去落点。
5. `pii_spans` 的 `start`/`end` **必须**是**该页 `full_text` 的字符偏移**(UTF-16 码元),半开区间 `[start, end)`。
6. **PDF 的 `page_no` 是 PDF 内部页序,与 `document_page.page_no` 不同源**(审核 #004 A-13)。
   一份 5 页 PDF 在 L1 与 DB 里是**一个** `document_page` 行(m0-03 §2:1 个 PDF = 1 个 page 对象),而模型会返回 5 个 `Stage1Page`。
   - M2 **禁止**为 PDF 建 `document_page` 展开行 —— 页级定位是 D5/M4 的事。
   - §5 的"同 `page_no` 出现两次即失败"其作用域是**同一 `document_page` 内的 PDF 内页序**,不是跨 `document_page`。
   - §2 要求的"页号已给出、直接采用"只适用于 image 块;PDF 走 `document` 块,**由模型自行按 PDF 内部页序编号**。

## 2. Prompt 的硬性要求

以下逐条写进 system prompt,并在回归集上验证([99](./99-acceptance.md) C 组):

1. **只抄写,不换算、不解释、不补全。**
2. **看不清就把 `doc_type_confidence` 压低,不要猜。** 猜错比留空危害大得多。
3. **不做任何医学判断。** 禁止出现"偏高提示…""建议复查…"这类内容。
4. **不解读图形区域。** 血常规直方图、超声截图识别为图像,不试图数值化。
5. **页序从页脚解析。** `page_label` 抄原文,`page_index`/`page_total` 从中解析;解析不出置 null。**禁止**用图像送入顺序推断页序(ADR-025/047)。
6. **保留限定词。** 「氧分压」与「氧分压(校正)」是两条不同记录,不可合并。
7. **上标单位照抄。** `10⁹/L` 不得写成 `109/L` 或 `10 9/L`。
8. **残差不丢弃**(ADR-043):装不进 schema 的结构进 `unmodeled`。

## 3. PII:识别、标注、丢弃(ADR-044 / 06 §3)

分两类,处置不同,**不得混淆**:

| 类别 | 字段 | 处置 |
|---|---|---|
| **丢弃类**(档案价值为零、泄露风险高) | 手机号、座机、身份证号、家庭住址、医保卡号、银行卡号 | 模型**必须**识别并在 `pii_spans` 标注;这些字段**禁止**出现在 `Stage1Out` 的任何结构化字段中 |
| **保留类**(归人必需) | 姓名、性别、年龄、院内标识 | 保留于结构化字段 |

1. `full_text` **必须完整**,包含丢弃类 PII 的原文 —— 它是 L2 工件,不出库、不进索引。这是与 ADR-015「完整性」的协调点:**完整性在工件层,最小化在消费层**。
2. **禁止**在 M2 建立任何全文索引或 embedding。M4 建索引时,**必须**由确定性代码按 `pii_spans` 遮蔽后再入索引。
3. 验收断言写在**索引层**而非提取层:M2 阶段的断言是"`derived/**/extractions/` 之外的任何地方不出现手机号"([99](./99-acceptance.md) A9)。

## 4. S1 工件落桶

key:`derived/{slug}/{short_id}/extractions/s1-v{NNN}.json`(`NNN` = `prompt_version`,三位零填充)

> 原版写 `s1@{prompt_version}.json` —— **`@` 不在 M0 冻结的 key 字节集** `[a-z0-9._/-]` 内,
> 走 `buildKey` 会直接抛"key 含非法字符",绕过 `buildKey` 手拼则 A30 红且开了"key 不走单一出处"的口子(审核 #004 A-3)。
> `packages/ai/prompts/{stage}/{id}@{version}.md` 是**本地文件路径**,不受此约束,无需改。
>
> `{slug}` **恒取权威归属 slug**(manifests 回放的结果),不是拍摄时刻的 slug(审核 #004 B-6)。
> 归人纠正时**必须**把 `document.s1_artifact_key` 置 null,强制下次按新前缀重生 —— 否则重建时按权威 slug 查找会对
> **所有被纠正过的文档**静默落空,表现为"被纠正过的文档在重建后系统性地更差",且没有任何信号。

**必须**在 `packages/storage` 登记:`ParsedKey` 新增 `extraction` 变体、`buildKey.extraction`、`MATCHERS` 新增 extraction 与 `_meta` 两条匹配器(后者是 A30 把 `derived/` 纳入扫描的前置条件)。
属 **L2**:不上锁、可整体删除、可重跑、打包不带、备份不带。**必须**在 docs/04 §1 权威矩阵登记。

工件内容 **必须**包含:

```jsonc
{
  "schema_version": "1.0",
  "stage": "s1",
  "document_short_id": "...",
  "produced_at": "...",              // 服务端时间
  "model": "claude-opus-5",          // ★ 实际服务模型(fallback 生效时是 fallback 模型)
  "prompt_id": "s1-classify",
  "prompt_version": 3,
  "prompt_sha256": "...",
  "effort": "medium",
  "usage": { "input_tokens": 0, "output_tokens": 0,
             "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
  "output": { /* Stage1Out */ }
}
```

1. 工件 **必须**以 `If-None-Match: *` 仅创建写。同 `prompt_version` 重跑 **必须**先删旧对象再写(显式覆盖),**禁止**盲写。
2. 不同 `prompt_version` 的工件 **必须**并存 —— 这是"换了 prompt 之后能对比两批产出"的唯一手段。
3. **禁止**把工件内容写进 journal。AI 产出属 L2,可重来。

## 5. 多页与分批合并

1. 一个文档的所有页 **必须**在一次调用内送出(≤ 20 页时),使模型能利用跨页上下文(项目编号跨页连续)。
2. 页数 > 20 时**必须**分批(每批 ≤ 20 页,按 `page_no` 升序切分),并按下列确定性规则合并,**禁止**再发一次"合并请求"让模型自己合:
   - `pages[]`:按 `page_no` 拼接,冲突(同 `page_no` 出现两次)时**失败**并转 `needs_human`。
   - `doc_type`:取各批中 `doc_type_confidence` 最高者;并列时取 `page_no` 最小的批次。
   - `patient_name` / `facility_name_raw` / `department_raw` / `sampled_on` / `reported_on`:取**首个非 null**(按 `page_no` 升序)。
   - `summary`:取首批的值。
   - `pii_spans` / `unmodeled`:按 `page_no` 归并,不去重。
   - 合并结果 **必须**在工件中记 `batches: N`,使"这是拼出来的"可被识别。

## 6. 落库

S1 完成后 **必须**在同一 DB 事务内更新 `document`:

| 列 | 来源 | 约束 |
|---|---|---|
| `doc_type` | `Stage1Out.doc_type` | 原 M1 恒为 `unknown` |
| `doc_type_confidence` | 同名 | 新列 |
| `sampled_on` / `reported_on` | 同名 | 新列,可空 |
| `department_raw` | 同名 | 新列,可空 |
| `event_time` | `Stage1Out.event_at` | **复用 M0 既有列**(审核 #004 A-5′)。报告确实印有时分时才写,否则留 NULL |
| `event_time_source` | 取值按 `docs/03 §226` | 与 `event_time` 同批写;`event_time` 为 NULL 时本列也必须为 NULL |
| `facility_id` | **不在此处写** | 由 [05](./05-reconciliation.md) §2 归一后写 |
| `s1_artifact_key` | 工件 key | 新列;为空表示未跑过 S1 |
| `s1_prompt_version` | 同名 | 新列 |

1. **禁止**在此写 `person_id` —— 归人是人的决定,S1 只能产生告警([05](./05-reconciliation.md) §1)。
2. **禁止**把 `full_text` 写进数据库(M2 不建索引;写进去就等于建了一个没人管的 PII 副本)。
3. `document` 的这些列均可从 S1 工件重算 ⇒ 属 L2 语义。**`rebuild-index` 禁止读取 S1 工件**(审核 #004 B-7):按 `docs/04 §7` 的恢复剧本,冷备里**根本没有 `derived/`**,这段代码在真实恢复时 100% 走不到 —— 于是演练(桶完好)与真实恢复(桶只有 L1)结果不同,而"没演练过的备份等于没有备份"这套逻辑正建立在**演练能代表真实恢复**之上。
   L2 列的恢复由 [04](./04-jobs.md) §2.2 既有的"为缺 `s1_artifact_key` 的文档重新投递 `stage1`"承担。若要省重跑成本,**可以**另做 `tools/` 下的独立 L2 补水脚本,**禁止**塞进 rebuild。
