# 06 · AI 管线

## 0. 总览

```
                    ┌──────────────────────────────────────────┐
原件(S3)──────────>│ S1  分类 + 元数据 + 全文                  │ 视觉模型
                    └────────────────┬─────────────────────────┘
                                     │  ★ 归人确认(人工)
                                     ▼
                    ┌──────────────────────────────────────────┐
                    │ S2  结构化提取(按 doc_type 分支)         │ 视觉 + 结构化输出
                    └────────────────┬─────────────────────────┘
                                     ▼
                    ┌──────────────────────────────────────────┐
                    │ S3  归一化(单位换算 / 指标字典映射)      │ ★ 纯代码
                    ├──────────────────────────────────────────┤
                    │ S4  算术自洽校验                          │ ★ 纯代码
                    └────────────────┬─────────────────────────┘
                                     ▼
                              observation 记录
                              (低置信/校验失败 → 标红待核)

音频 ──> ASR 转写 ──> 结构化抽取 ──> context_answer
```

**S3/S4 是纯代码,不是 AI。** 单位换算和算术校验必须确定性 —— 让模型做算术是引入错误,不是消除错误。

---

## 1. 模型选型

| 用途 | 模型 | 说明 |
|---|---|---|
| 视觉提取、分类、结构化 | **`claude-opus-5`** | $5 / $25 每百万 token;1M 上下文;高分辨率视觉(长边 2576px) |
| 语音转写 | **独立 ASR 服务** | Claude API **不接受音频输入**,必须单独选型 |
| 文本 embedding | 独立 embedding 服务 | 用于语义检索 |

### 为什么视觉提取用 Opus 5

- **高分辨率视觉**:长边支持到 2576px(每图最多约 4784 个视觉 token)。化验单的小数点、上下标、密集表格恰恰吃这个分辨率。
- **结构化输出**:`output_config.format` 用 JSON Schema 约束返回,免去解析与重试逻辑。
- **中文与手写混排**表现好。

### ASR 选型(待定,需实测)

Claude 不处理音频,需要单独的 ASR。候选:

| 方案 | 考量 |
|---|---|
| Whisper(自托管 large-v3) | 免费、可控;中文医学术语准确率需实测 |
| Whisper API | 简单;成本极低(音频量小) |
| 国内 ASR(阿里云 / 讯飞 / 腾讯) | 中文口语与方言通常更好,部分提供医疗领域模型 |

> ⚠️ 医学术语("肌酐"、"糖化血红蛋白"、"甲状腺功能五项")对通用 ASR 是难点。**选型前必须用真实录音实测**,不要凭产品页宣传决定。
> 缓解手段:转写后用 Claude 做一次"医学术语纠错 + 结构化",利用上下文修正 ASR 错误。

---

## 2. Stage 1 — 分类与元数据

一次调用同时产出:文档类型、人、日期、机构、科室、**完整文本**。

**全文是这一步最重要的产出。** 结构化提取会失败,全文不会 —— 它是检索的兜底能力。

```ts
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const client = new Anthropic();

const ClassifySchema = z.object({
  doc_type: z.enum([
    'lab_report', 'imaging_report', 'prescription', 'discharge_summary',
    'pathology', 'outpatient_note', 'checkup_report', 'ecg',
    'vaccination', 'other', 'unknown',
  ]),
  doc_type_confidence: z.number().min(0).max(1),
  patient_name: z.string().nullable(),
  patient_sex: z.enum(['male', 'female', 'unknown']).nullable(),
  patient_age_text: z.string().nullable(),
  patient_identifiers: z.array(z.object({
    type: z.string(),
    value: z.string(),
  })),
  facility_name: z.string().nullable(),
  department: z.string().nullable(),
  sampled_on: z.string().nullable(),   // YYYY-MM-DD
  reported_on: z.string().nullable(),
  summary: z.string(),                  // 一句话:这是什么单子
  full_text: z.string(),                // ★ 完整文本,保留原始换行与表格结构
});

const response = await client.messages.parse({
  model: 'claude-opus-5',
  max_tokens: 16000,
  output_config: {
    format: zodOutputFormat(ClassifySchema),
    effort: 'medium',
  },
  system: [{
    type: 'text',
    text: CLASSIFY_SYSTEM_PROMPT,           // 稳定内容放前面
    cache_control: { type: 'ephemeral' },   // ★ 命中缓存,后续请求便宜 ~90%
  }],
  messages: [{
    role: 'user',
    content: [
      // 用预签名 URL,避免 base64 让请求体膨胀 4/3
      { type: 'image', source: { type: 'url', url: presignedPageUrl } },
      { type: 'text', text: '识别这份医疗单据。' },
    ],
  }],
});

const meta = response.parsed_output!;
```

**要点:**

- **`cache_control` 放在稳定的 system prompt 上。** Opus 5 的最小可缓存前缀是 512 token,提取 prompt 一定超过。缓存命中后这部分只按 0.1× 计价。
- **图片用预签名 URL**,不用 base64 —— 后者让请求体膨胀 1/3。
- 日期一律要求 `YYYY-MM-DD`,解析失败置 null 而非猜测。

---

## 3. Stage 2 — 结构化提取

按 `doc_type` 走不同 prompt 与 schema。化验单是主战场。

### 化验单 Schema(关键字段说明)

```ts
const LabObservation = z.object({
  local_name: z.string(),              // ★ 报告上的原始名称,原样保留
  value_raw: z.string(),               // ★ 原样字符串,含 "<0.01" / "阴性"
  unit_raw: z.string().nullable(),     // ★ 报告上的原始单位,不做换算
  ref_low: z.number().nullable(),      // ★ 该报告自带的参考区间
  ref_high: z.number().nullable(),
  ref_text: z.string().nullable(),     // 非数值区间,如 "阴性"
  abnormal_flag: z.enum(['H','L','HH','LL','N','A']).nullable(),  // 报告上的 ↑↓
  method: z.string().nullable(),       // 方法学
  specimen: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  source_bbox: z.object({              // ★ 归一化坐标,用于点回原图
    page_no: z.number(), x: z.number(), y: z.number(),
    w: z.number(), h: z.number(),
  }).nullable(),
});

const LabReportSchema = z.object({
  observations: z.array(LabObservation),
  panel_names: z.array(z.string()),    // 如 ["血脂四项", "肝功能"]
  notes: z.string().nullable(),
});
```

### Prompt 的硬性要求

写进 system prompt 并在回归集上验证:

1. **只抄写,不换算、不解释、不补全。** 单位、参考区间、异常标记一律原样照抄。
2. **看不清就标 `confidence` 低,不要猜。** 猜错比留空危害大得多。
3. **参考区间必须逐行提取**,不要复用上一行的。
4. **`source_bbox` 用归一化坐标**(0–1),与图片尺寸解耦。
5. **不做任何医学判断。** 不写"偏高提示高脂血症"这类内容。

---

## 4. 数字幻觉:三道防线

视觉模型整体可用,但**数字恰恰是它最弱的地方** —— 小数点丢失、长表格串行、上下标误读。

### 防线 1:结构化输出

`output_config.format` 保证返回结构合法,消除了解析层的错误。但**不保证数值正确**。

### 防线 2:算术自洽校验(纯代码,零成本)

化验单内部本身有冗余关系,可以免费查错。**小数点错一位,这些等式立刻崩掉。**

| 规则 | 校验式 | 容差 |
|---|---|---|
| `wbc_differential_sum` | 白细胞分类百分比之和 ≈ 100% | ±2% |
| `wbc_absolute_consistency` | 各分类绝对值 ≈ 总数 × 百分比 | ±10% |
| `lipid_panel_sum` | TC ≈ LDL-C + HDL-C + TG/2.2 | ±15%(Friedewald 近似) |
| `protein_sum` | 总蛋白 = 白蛋白 + 球蛋白 | ±3% |
| `ag_ratio` | 白球比 = 白蛋白 / 球蛋白 | ±5% |
| `egfr_creatinine` | 报告的 eGFR 与从肌酐算出的一致 | ±10% |
| `anion_gap` | Na⁺ − (Cl⁻ + HCO₃⁻) 在 8–16 mmol/L | 超出即标记 |
| `ref_range_sanity` | 参考区间下限 < 上限,且数值量级与区间同级 | 硬性 |
| `unit_magnitude` | 数值与该指标常见量级相差 > 10 倍 | 标记 |

> ⚠️ `lipid_panel_sum` 的 Friedewald 关系在 **TG > 4.5 mmol/L 时失效**,该情况下跳过此规则,不报错。
> 这些规则实现在 `packages/medical/src/consistency/`,是纯函数,单元测试覆盖率要求最高。

### 防线 3:双次提取取差集(可选)

对高价值文档(化验单、病理报告)跑两遍,不一致的字段标红。成本翻倍但只在提取阶段,而且总额本就极低。

```ts
const [a, b] = await Promise.all([extract(doc), extract(doc)]);
const disagreements = diffObservations(a, b);   // 按 local_name 对齐
// 有分歧的字段 → confidence 置低 + 标红待核
```

### 目标不是零错误,是让错误可见

标出来 + 能一键看原图核对,就够了。这也是为什么 `source_bbox` 是必需字段而非可选。

---

## 5. Stage 3/4 — 归一化与校验(纯代码)

```ts
import { mapConcept, convertToSi, runConsistencyChecks } from '@repo/medical';

for (const raw of extracted.observations) {
  const concept = mapConcept(raw.local_name);        // "低密度脂蛋白胆固醇" → LDL_C
  const si = convertToSi(concept, raw.value_num, raw.unit_raw);

  await insertObservation({
    ...raw,
    concept_code: concept?.code ?? null,
    loinc_code: concept?.loinc ?? null,
    value_si: si?.value ?? null,
    unit_si: si?.unit ?? null,
    conversion_version: si?.version,
    review_status: 'unreviewed',
  });
}

const flags = runConsistencyChecks(observations);
```

**指标字典映射失败时不要丢弃数据** —— `concept_code` 置 null,`local_name` 与原值照常入库。以后字典补全了可以重跑映射,数据不会丢。

---

## 6. 音频管线

```
录音(m4a) ──> S3 归档(永不删除)
                  │
                  ├──> ASR ──> transcript(派生层,可重跑)
                  │              │
                  │              └──> Claude 结构化抽取
                  │                     ├─ 医学术语纠错
                  │                     ├─ 症状/用药/医嘱抽取
                  │                     └─ 写入 context_answer.structured
```

结构化抽取的 schema 按问题类型定:

```ts
// doctor_advice 这类问题的抽取目标
const AdviceSchema = z.object({
  diagnosis_mentioned: z.array(z.string()),
  medications_mentioned: z.array(z.object({
    name: z.string(), dose: z.string().nullable(), frequency: z.string().nullable(),
  })),
  followup: z.object({ interval: z.string().nullable(), what: z.string().nullable() }).nullable(),
  lifestyle_advice: z.array(z.string()),
  raw_summary: z.string(),
});
```

**转写与结构化都记录模型与版本**,与影像提取一致,支持整体重跑。

---

## 7. 重跑

未来模型变强时,对整个档案重跑:

```
tools/reextract --person p3f7a2 --doc-type lab_report --prompt-version v4
```

规则:

1. 生成新 `extraction`(version+1),旧版标 `superseded`,**不删除**
2. **`review_status ∈ (confirmed, corrected)` 的 observation 不被覆盖** —— 人工修正永远优先
3. 新旧结果差异生成报告,供人工抽查
4. 分批执行,可中断可续跑

---

## 8. 成本

单张化验单(高分辨率图 + 缓存命中的 prompt,`effort: medium`):

| 项 | token | 费用 |
|---|---|---|
| 图片输入 | ~4,800 | $0.024 |
| Prompt(缓存命中,0.1×) | ~2,000 → 200 计费 | $0.001 |
| 输出(含思考) | ~3,000 | $0.075 |
| **合计** | | **≈ $0.10 ≈ 0.7 元/张** |

一家五口一年 100–300 份 → **每年几十到两百元**。双次提取翻倍仍然可接受。

### 成本控制手段(按优先级)

1. **prompt 缓存** —— 提取 prompt 与指标字典是稳定前缀,必开
2. **`effort` 调优** —— Opus 5 在 `low` / `medium` 上表现意外地好,而提取属于抄写类任务而非深度推理。**从 `medium` 起步,用回归集对比 `low` 是否够用**
3. 只对高价值文档做双次提取
4. 图片按需上高分辨率 —— 化验单需要,门诊病历本可能不需要

---

## 9. 错误处理

### `stop_reason: "refusal"`

Opus 5 有安全分类器,可能拒绝请求(HTTP 200,`stop_reason: "refusal"`)。医疗内容通常不触发,但**必须在读取 `content` 前判断**,否则代码会崩:

```ts
if (response.stop_reason === 'refusal') {
  await markExtractionFailed(doc.id, 'refusal', response.stop_details?.category);
  return;   // 不重试同一 prompt
}
```

同时建议开启服务端 fallback:

```ts
const response = await client.beta.messages.create({
  model: 'claude-opus-5',
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',   // 按拒绝类别自动路由到推荐的备选模型
  // …
});
```

### 其余

| 情况 | 处理 |
|---|---|
| 限流 429 | SDK 自动重试(默认 2 次);任务队列再加指数退避 |
| 超时 | 大 `max_tokens` 用流式,避免 HTTP 超时 |
| 结构化输出校验失败 | 记录原始响应,置 `extraction.status = failed`,**保留原件与已有全文**,不阻塞归档 |
| 图片不可读 | `doc_type = unknown`,`full_text` 留空,仍然入库 —— **归档永远不因识别失败而中断** |

> **归档管道与提取管道必须解耦。** AI 挂了、额度用尽了、模型下线了 —— 原件照常入库。这是"影像即真相"架构的直接推论。

---

## 10. 安全边界

- **API 密钥只在服务端。** 任何情况下不下发到客户端。
- **AI 输出不直接执行。** 提取结果只写入数据结构,不用于任何控制流决策。
- **prompt 注入防护:** 单据上的文字属于不可信输入。system prompt 明确指示模型只做抄写,忽略图片中出现的任何指令。
- **不生成医学结论。** 在 system prompt 中显式禁止,并在回归集中加入验证用例。
