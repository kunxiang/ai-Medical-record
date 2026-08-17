# 06 · AI 管线

## 0. 总览

```
                    ┌──────────────────────────────────────────┐
原件(S3)─┬────────>│ S1  分类 + 元数据 + 全文                  │ 视觉模型
   ★真相   │        └────────────────┬─────────────────────────┘
   来源    │                         │  ★ 归人确认(人工)
           │                         ▼
           │        ┌──────────────────────────────────────────┐
           │        │ S2  结构化提取(按 doc_type 分支)         │ 视觉 + 结构化输出
           │        └────────────────┬─────────────────────────┘
           │                         ▼
           │        ┌──────────────────────────────────────────┐
           │        │ S3  归一化(判断:AI+决策缓存 / 执行:算术)│ ★ ADR-040
           │        ├──────────────────────────────────────────┤
           │        │ S4  Tier0 结构 + Tier1 算术自洽校验       │ ★ 纯代码
           │        └────────┬────────────────────┬────────────┘
           │           通过  │                    │ 失败且 on_failure=reread
           │                 ▼                    │
           │          observation 记录            │
           │                                      │
           └──── 裁剪失败区域 + 失败详情 ◄────────┘
                 针对性重读(最多 3 轮)
                 仍失败 → 人工核查队列

音频 ──> ASR 转写 ──> 结构化抽取 ──> context_answer
```

> **闭环之所以可能,是因为原件永远在**(ADR-001)。校验失败时可以回到真相来源重看 —— 这是"影像即真相"最实用的一个推论。

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
    'vaccination', 'infusion_order', 'other', 'unknown',   // ★ 从 contracts 导出,勿在此维护
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
  pii_spans: z.array(z.object({         // PII 位置标注(ADR-044:完整文本只进 sidecar,
    kind: z.string(), start: z.number(), end: z.number(),  // 入索引/embedding 前由确定性代码按 span 遮蔽)
  })),
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
  abnormal_flag_raw: z.string().nullable(),  // 原始符号照抄(↑/↑↑↑/※/H…)—— 标准化由归一层按上下文判断(ADR-035)
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
6. **保留限定词。** 「氧分压」与「氧分压(校正)」是两行不同的记录,`qualifier` 分别为 null 和 `corrected`,不可合并。
7. **提取每行的检测仪器与检测方法**,写入 `device` / `method`。
8. **识别非结果行。** 血气报告中的体温、吸氧浓度是仪器输入参数,标 `result_kind = input_parameter`。
9. **残差通道(ADR-043)。** 每个 schema 带 `unmodeled: [{label, value, region}]` —— 装不进 schema 的结构必须进残差,**禁止丢弃**。残差是「schema 该长了」的原始信号,由策展员聚类后生成晋升提案。

### 已知 OCR 陷阱(写进 prompt 的检查清单)

| 陷阱 | 说明 |
|---|---|
| **上标单位** | `10⁹/L` 易被读成 `109/L`、`10 9/L`。同理 `10¹²/L`、`1.73m²` |
| **箭头图例** | 中国报告页脚约定:`↑` 升高、`↓` 降低、**`↑↑↑` / `↓↓↓` 危急值**、`※` 阳性。三箭头 → `HH`/`LL` |
| **小数点** | `0.86` ↔ `8.6`、`73.7` ↔ `737`。靠自洽校验兜底 |
| **负值** | 「细胞外液碱剩余 −5」的负号易丢 |
| **同名行** | 同一份报告出现两次「PH」(校正/未校正),不可去重 |
| **图形区域** | 血常规第 2 页有 PLT / RBC / DIFF / WNB 直方图与散点图 —— **识别为图形,不试图数值化**,原图保留即可 |
| **无参考区间的行** | 体温、吸氧浓度、TCO₂ 等本就没有区间,`ref_low`/`ref_high` 留空,**不要从别处借** |

### ⚠️ PII 最小化提取

> **对档案价值为零、但泄露风险高的字段,识别后主动丢弃,不写入数据库。**

真实案例:化验单上没有电话,**输液单上印着家长手机号**。这类字段对长期病历archive 毫无价值,却是最敏感的个人信息。

| 字段 | 处理 |
|---|---|
| 手机号 / 座机 | 识别 → **丢弃**,不输出 |
| 身份证号 | 识别 → **丢弃** |
| 家庭住址 | 识别 → **丢弃** |
| 医保卡号 / 银行卡号 | 识别 → **丢弃** |
| 姓名、性别、年龄、院内标识 | 保留(归人必需) |

原图里当然仍有这些信息 —— 但那是不可变原件,不进入结构化层、不进入全文索引、不进入 embedding。

**full_text 分两层**(消解与 ADR-015「完整性」的矛盾,审核 C-F8):S3 sidecar 存**带 PII span 标注的完整文本**(与原件同级,不出库);入全文索引与 embedding 前,由**确定性代码**按 span 遮蔽。回归断言相应改为:**索引层出现手机号即判定失败**(而非提取输出层 —— 提取层必须完整)。

### 影像 / 叙述型报告的提取

与化验单走不同的 schema。产出四块:

```ts
const ImagingReportSchema = z.object({
  exam_items: z.array(z.string()),        // ★ 检查覆盖范围,见下
  findings_text: z.string(),              // 检查所见(叙述段,原文)
  conclusions: z.array(z.object({         // ★ 结论逐条,原文不改写
    text: z.string(),
    laterality: z.enum(['left','right','bilateral']).nullable(),
    tags: z.array(z.string()),            // 额外加的检索标签
  })),
  recommendation: z.string().nullable(),  // 建议
  measurements: z.array(z.object({        // 可纵向追踪的测量值
    local_name: z.string(),
    body_site: z.string().nullable(),
    // 开放维度数组:2D/3D/角度均可容纳(ADR-042)。ellipsoid_volume 校验
    // 声明「恰好 3 个长度维度」为适用条件,不满足则静默跳过
    dimensions: z.array(z.object({
      label: z.string(), value: z.number(), unit: z.string(),
    })).nullable(),
    value_num: z.number().nullable(),
    unit_raw: z.string().nullable(),
  })),
});
```

**硬性要求:**

1. **结论逐条原文保留,不改写、不归一、不合并。** 「未见明显异常」≠「正常」;「未显示明显占位性回声」是规范表述,改写即失真。
2. **`exam_items` 必须提取。** `@@` 是 HIS 字段分隔符,拆成数组:
   `胃肠道及腹膜腔扫查超声【胃及十二指肠@@阑尾及系膜淋巴结@@下消化道】阴囊、双侧睾丸、附睾超声`
   → `["胃及十二指肠","阑尾及系膜淋巴结","下消化道","阴囊","双侧睾丸","附睾"]`
3. **测量值带解剖部位。** 左右侧是两条独立时间序列。
4. **报告内嵌的超声/影像截图不解读**,与血常规直方图同样处理 —— 识别为图像区域,原图保留。

### 输液单 / 注射单的提取

```ts
const InfusionOrderSchema = z.object({
  groups: z.array(z.object({
    group_no: z.number(),
    total_volume_ml: z.number().nullable(),
    route: z.string(),                    // 静滴 / 静脉续滴
    frequency_raw: z.string(),            // ★ 原文,不解析
    items: z.array(z.object({
      name_raw: z.string(),               // ★ 含厂家、集采批次的原文
      generic_name: z.string().nullable(),// 剥离采购信息
      concentration_pct: z.number().nullable(),
      dose_raw: z.string(),
    })),
  })),
  charges: z.array(z.object({ item: z.string(), amount: z.number() })).nullable(),
  handwritten_annotations: z.array(z.string()),  // 低置信度,不进结构化字段
});
```

**要点:**

- `name_raw` 保留 `5%葡萄糖注射液(科伦250ml,23年集采)` 全文;`generic_name` 剥离为 `葡萄糖`
- 剂量单位混用(`0.15克` / `50毫克` / `250毫升`),交给 `packages/medical/units/dose` 归一,**不在 prompt 里换算**
- 频次中英混排(`静滴 ONCE 1天`)**原文保留,不解析**
- 手写标记(如排队号)标 `handwritten_annotations`,低置信度,不参与任何结构化字段

### 多页报告的页序

⚠️ **页序必须从页脚的「第 N 页,共 M 页」解析,绝不能依赖拍摄顺序。**

真实场景中用户经常先拍到第 2 页(纸是折叠的)。而多页报告的项目编号**跨页连续**(第 1 页 NO 1–20,第 2 页 NO 21–27)—— 顺序错了,提取结果会错乱。

```
Stage 1 额外产出:page_label(页脚原文)、page_no、page_total
Stage 2 之前:按 page_no 重排,再合并为一次提取
```

拍摄顺序单独存入 `document_page.capture_order`,仅用于排查上传问题。

---

## 4. 数字幻觉:三道防线

视觉模型整体可用,但**数字恰恰是它最弱的地方** —— 小数点丢失、长表格串行、上下标误读。

### 防线 1:结构化输出

`output_config.format` 保证返回结构合法,消除了解析层的错误。但**不保证数值正确**。

### 防线 2:算术自洽校验(纯代码,零成本)

化验单内部本身有冗余关系,可以免费查错。**小数点错一位,这些等式立刻崩掉。**

#### Tier 0 · 结构完整性(专抓换行 / 丢行 / 串行)

**这一层比算术校验更靠前,因为换行错误会让后面所有校验失去意义** —— 值挂到了错误的行名上,算术反而可能"碰巧通过"。

| 规则 | 校验式 |
|---|---|
| `row_numbering_continuous` | NO 从 1 开始,连续无跳号 |
| `row_count_matches_max_no` | 提取行数 == max(NO) |
| `page_numbering_complete` | 页脚「第 N 页,共 M 页」的 M 页全部到齐,且编号跨页衔接 |
| `required_columns_present` | 按 `column_set`,每行必填列非空 |
| `no_orphan_cells` | 无「有值无项目名」或「有项目名无值」的行 |
| `unit_column_uniformity` | 同一列的单位形态一致(混入 `109/L` 与 `10^9/L` 提示上标误读) |

> 实证:[用例 004](../fixtures/004-influenza-visit/) 的血常规 NO 跨两页连续 1–27。**丢一行 → 编号跳号 → 立刻暴露。**
> 这是唯一能捕获"OCR 漏读整行"的手段 —— 数值层面的校验对此完全无感。

#### 血常规

| 规则 | 校验式 | 容差 |
|---|---|---|
| `wbc_differential_sum` | 白细胞分类百分比之和 ≈ 100% | ±2% |
| `wbc_absolute_sum` | 各分类绝对值之和 ≈ WBC | ±3% |
| `wbc_absolute_consistency` | 各分类绝对值 ≈ WBC × 百分比 | ±10% |
| **`rbc_indices`** ★ | **MCV(fL) = HCT(%)/RBC(10¹²/L)×10**<br>**MCH(pg) = Hb(g/L)/RBC(10¹²/L)**<br>**MCHC(g/L) = Hb(g/L)/HCT(%)×100** | ±3% |
| **`platelet_crit`** ★ | PCT = PLT × MPV / 10000 | ±5% |

> ★ **红细胞三角关系是性价比最高的规则。** MCV / MCH / MCHC 三个值全部由 RBC、Hb、HCT 三个实测值算出 —— 六个数字互相咬合,任何一个 OCR 错了立刻暴露。真实数据实测:MCV 73.69(报告 73.7)、MCH 25.15(25.2)、MCHC 341.2(341),全部命中。

#### 血气分析

| 规则 | 校验式 | 容差 |
|---|---|---|
| **`henderson_hasselbalch`** ★ | pH = 6.1 + log₁₀( HCO₃⁻ / (0.0301 × pCO₂) ) | ±0.05 pH 单位 |
| `tco2_identity` | TCO₂ = HCO₃⁻ + 0.03 × pCO₂ | ±5% |
| `istat_hb_hct` | iSTAT 血红蛋白(g/dL) = HCT(%) × 0.34 | ±3% |
| `anion_gap` | Na⁺ − (Cl⁻ + HCO₃⁻) 在 8–16 mmol/L | 超出即标记 |

> ★ **Henderson-Hasselbalch 在血气单上几乎是恒等式** —— 多数血气仪的 HCO₃⁻ 本身就是由 pH 与 pCO₂ 反算的,所以偏差只来自显示位数取整。真实数据实测:算得 7.405,报告 7.394,差 0.011。**一旦偏差超过 0.05,几乎必定是 OCR 读错了某个数字。**
>
> `istat_hb_hct` 同时是一个**方法学识别规则** —— 命中即说明该 Hb 是计算值而非实测值,应置 `result_kind = calculated`。

#### 生化 / 通用

| 规则 | 校验式 | 容差 |
|---|---|---|
| `lipid_panel_sum` | TC ≈ LDL-C + HDL-C + TG/2.2 | ±15%(Friedewald 近似) |
| `protein_sum` | 总蛋白 = 白蛋白 + 球蛋白 | ±3% |
| `ag_ratio` | 白球比 = 白蛋白 / 球蛋白 | ±5% |
| `egfr_creatinine` | 报告的 eGFR 与从肌酐算出的一致 | ±10% |
| `ref_range_sanity` | 参考区间下限 < 上限,且数值量级与区间同级 | 硬性 |
| `unit_magnitude` | 数值与该指标常见量级相差 > 10 倍 | 标记 |

#### 影像测量

| 规则 | 校验式 | 容差 |
|---|---|---|
| **`ellipsoid_volume`** ★ | 估算体积 = 0.5236 × L × W × H | ±5% |
| `dimension_order` | 三维中最大者应等于报告标注的「最大径」 | 硬性 |

> ★ 真实数据实测:左 1.4×0.6×0.9×0.5236 = **0.3958**(报告 0.39 ✓);右 1.3×0.7×0.8×0.5236 = **0.3812**(报告 0.37,差 3%)。
>
> **这条规则的额外价值:给没给体积的旧报告补算,让历史数据可比。** 2024 年那份只有三维尺寸,套同一公式即可与 2026 年的报告体积落到同一根轴上 —— 派生值置 `is_derived = true`、`derived_formula = ellipsoid-0.5236`。

#### 跨报告(同一 encounter)

| 规则 | 校验式 |
|---|---|
| `cross_device_agreement` | 同一次采血、不同仪器的同一指标(Hb、HCT、K⁺、Na⁺、葡萄糖),归一单位后偏差 > 10% 时标记 |

> 真实数据实测:iSTAT 血红蛋白 126 g/L vs 血球仪 130 g/L,差 3.1% —— 属正常方法学差异,不报警。**这条规则的价值在于抓另一种错误:单位换算搞错了。** 若一边是 126 一边是 1300,立刻暴露。

---

**两条实现约束:**

1. **缺数据时静默跳过,不报错。** 真实案例中血气单没有氯离子 → `anion_gap` 无法计算。规则引擎必须优雅降级,否则会对完全正常的报告刷屏告警。
2. `lipid_panel_sum` 的 Friedewald 关系在 **TG > 4.5 mmol/L 时失效**,该情况跳过。

这些规则实现在 `packages/medical/src/consistency/`,是纯函数,**单元测试覆盖率要求最高**。回归用例见 [`fixtures/`](../fixtures/)。

### 防线 3:★ 校验驱动的多轮闭环重读

**提取不是一轮。校验失败不是终点,是"回原图重看"的信号。**

#### 3.1 先验:报告是自洽的,不自洽的是我的读法

实证:**4 个真实用例、26 次规则执行、零失败**([fixtures/](../fixtures/))。

原因是结构性的 —— MCV、MCH、MCHC、PCT、HCO₃⁻、TCO₂、估算体积**都是仪器自己算出来的**,不可能与源数据不自洽。医院 LIS 输出报告前,这些等式已经成立。

因此对派生值类校验:

```
P(OCR 读错) >> P(报告本身错)
```

→ **失败时的默认假设是「我读错了」,而不是「标红等人工」。**

#### 3.2 但先验有边界 —— 不是所有失败都该重读

否则闭环会对着"不是错误的差异"反复重试,浪费且永不收敛。

每条规则带 `on_failure` 属性:

| `on_failure` | 适用 | 理由 |
|---|---|---|
| **`reread`** | Tier 0 结构完整性、派生值关系、分类和/绝对值和 | 仪器算的,必然自洽 → 失败必是读错 |
| **`flag`** | `cross_device_agreement`、跨标本类型、参考区间冲突 | **差异是真实的**(方法学/标本/设备),不是 OCR 错误 |
| `ignore` | 缺输入而跳过 | 静默,不告警 |

> 反例警示:iSTAT 血红蛋白 126 g/L vs 血球仪 130 g/L 差 3.1% —— **重读一百遍也还是 3.1%**,因为那是真实的方法学差异。这类失败若触发重读,是纯浪费。

#### 3.3 针对性重读,不是盲目重跑

校验失败会**指名道姓**告诉你哪几个格子有嫌疑。利用这一点:

```
校验失败
  ↓
定位涉及字段 → 取其 source_bbox
  ↓
裁剪原图相应区域(+ 表头行作上下文)
  ↓
★ 盲审重读 —— 只给嫌疑位置,不给期望值:
  「请重新读取裁剪图中这三个格子的数值与单位。
    注意小数点、位数与正负号。
    独立读取,不要参考任何先前结果。」
  ↓
重新校验(确定性代码,不是 AI)
```

**⚠️ 重读 prompt 里严禁出现期望值。** 若 prompt 写成「算得 341.2,但读到 34.1,请重读」,模型会倾向直接抄 341.2 —— 闭环退化为确认偏误机器:校验永远通过,但通过的是"模型顺从",不是"读对了"。盲审下重读值与期望值独立地收敛,才构成证据([ADR-044](./adr.md#adr-044))。

补充防线:对 `converged_to_expected`(重读后恰好等于期望值)的案例按比例抽样进人工复核 —— 如果盲读也总能"恰好"读出期望值,要么真读对了,要么裁剪图泄露了信息,抽样能区分这两者。

| 失败层级 | 裁剪范围 |
|---|---|
| 单元格级(MCHC 对不上) | 该行 + 表头行 |
| 行结构级(编号跳号) | 缺失编号前后各 2 行 |
| 页级(页数不齐 / 大面积失败) | 整页重读 |

**两个额外好处:**

1. **更便宜** —— 裁剪区域的 token 数远小于整页
2. **更准** —— 同样的模型分辨率下,裁剪区域的每字符像素数更高

#### 3.4 终止条件

闭环必须能停:

```
最多 3 轮
每轮失败数必须严格下降,否则立即中止
仍失败 → 进人工核查队列,附带各轮读数与失败详情
```

**每一轮的读数全部留档。** 若第 2 轮读出与第 1 轮不同的值,这个分歧本身就是信息 —— 与双次提取取差集同源,应一并呈现给人工核查者。

#### 3.5 数据模型

`extraction` 增加三个字段:

| 字段 | 说明 |
|---|---|
| `round` | 第几轮(1 起) |
| `triggered_by` | 触发本轮的失败规则列表;第 1 轮为 null |
| `parent_extraction_id` | 上一轮的 extraction |

同一 document 的多轮 extraction **共享一个 `version`**,`is_active` 指向最后一轮。轮次记录不删除 —— 它是"当时怎么一步步读对的"的凭证。

#### 3.6 与确定性校验的关系

这个闭环让 [ADR-016](./adr.md#adr-016--算术自洽校验用纯代码不用-ai) 的地位**变强而非变弱**:

> 确定性校验不再只是"标红给人看",它是**闭环的控制器** —— 由它决定要不要重读、重读哪里。

而这个角色**要求它独立于提取层**。若校验也由同一模型做,错误相关,它永远不会说"你读错了" —— 闭环就永远不触发。

```
AI 读 → 确定性判定对错 → AI 带着判定结果重读 → 确定性再判定
```

**AI 负责读,算术负责判对错。** 两者必须来自不同的来源,闭环才有意义。

### 防线 4:双次提取取差集(可选)

对高价值文档(化验单、病理报告)跑两遍,不一致的字段标红。成本翻倍但只在提取阶段,而且总额本就极低。

```ts
const [a, b] = await Promise.all([extract(doc), extract(doc)]);
const disagreements = diffObservations(a, b);   // 按 local_name 对齐
// 有分歧的字段 → confidence 置低 + 标红待核
```

### 目标:先自愈,自愈不了再让错误可见

```
Tier 0/1 校验失败 ──> 针对性重读(最多 3 轮)──> 通过 ✅
                                            └─> 仍失败 ──> 标红 + 一键看原图
```

**大部分 OCR 错误应该被闭环自动修掉,人工核查队列只接收真正难的。**

`source_bbox` 因此从"方便人工核对"升级为**闭环的必需输入** —— 没有它就无法裁剪重读区域。

---

## 5. Stage 3/4 — 归一化与校验

Stage 3 拆成**判断**与**执行**两半([ADR-040](./adr.md)):

```
原始行(local_name / unit_raw / 上下文)
   ↓
① 判断「这是什么」 —— AI + normalization_decision 缓存
   指纹 = hash(decision_type, 规范化输入)
   命中已生效决策 → 直接复用(零成本、确定性重放)
   未命中 → AI 判断 → 落决策表(proposed)
        ├─ 映射类(可逆):高置信即生效
        └─ 合并类(有损):等待人工确认才生效
   ↓
② 执行「怎么算」 —— packages/medical 纯函数
   convertToSi(concept, value, ucum)    // 换算算术,确定性
   runTier0 / runConsistencyChecks      // 校验算术,确定性
   deriveFormulas                        // eGFR / 椭球体积…
```

```ts
import { convertToSi, runConsistencyChecks } from '@repo/medical';

for (const raw of extracted.observations) {
  // 判断:缓存命中直接返回;未命中 → AI → 落决策表
  const d = await resolveDecision('concept_map', fingerprintOf(raw));

  // 执行:只接受已识别的 UCUM 码,算术确定性
  const si = d?.ucum ? convertToSi(d.concept_code, raw.value_num, d.ucum) : null;

  await insertObservation({
    ...raw,
    concept_code: d?.concept_code ?? null,   // 低置信 → null,原值照常入库
    value_si: si?.value ?? null,
    unit_si: si?.unit ?? null,
    conversion_version: si?.version,
    normalization_decision_id: d?.id ?? null, // 溯源:为什么这样归一
    review_status: 'unreviewed',
  });
}

const flags = runConsistencyChecks(observations);
```

**不变式保留:低置信不映射,数据不丢。** `concept_code` 置 null、原值照常入库;决策表留 `proposed`,人工确认后**重放映射即可补全** —— 不再需要"人工补字典 → 重跑"的流程,字典成为已确认决策的导出快照。

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
