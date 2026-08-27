# M2 Spec · 02 AI 调用封装与 prompt 版本管理

包:`packages/ai`(新)。运行时依赖只允许 `@anthropic-ai/sdk`、`@amr/contracts` 及 schema 编译所需的 `zod` / `zod-to-json-schema`;**禁止**依赖 `@amr/api`、`@amr/storage`(CI 断言 B1)。后两者只把 contracts 的 Zod 3 schema 转为供应商接受的 JSON Schema；业务输出仍必须由 contracts schema 终校验([CHANGES](./CHANGES.md) #14)。

## 1. 客户端构造

- Anthropic 路径**必须**使用官方 SDK `@anthropic-ai/sdk`;DeepSeek 视觉路径使用其 Responses API 兼容适配器。两条路径都必须经过同一 `Transport` 注入边界，**禁止**在业务 handler 内直接发模型 HTTP。
- provider 默认模型必须定义于 `packages/ai/src/models.ts` 单一出处：Anthropic 为 `claude-opus-5`，DeepSeek 为项目所有者指定的 `deepseek-v4-flash-vision-exp`。部署可用 `AI_MODEL` 钉住同 provider 的实验版本；调用点**禁止**内联模型名。
- 凭证**必须**从环境解析；**禁止**在代码中硬编码 key，**禁止**把 key 写进日志、工件或任何落桶对象。Anthropic 使用 SDK 环境解析；DeepSeek 适配器只在发请求时读取 `DEEPSEEK_API_KEY`。
- 客户端超时 **必须** 显式设为 600000(TypeScript SDK 单位为**毫秒**);重试次数保持 SDK 默认 2。
  > ⚠️ **显式 timeout 会关闭 SDK 的非流式长请求守卫**(审核 #004 A-8)。SDK 在**没有**显式 timeout 时会按
  > `expectedTime = 3_600_000 × max_tokens / 128_000` 估算,超过 600 秒即抛错要求改用流式(阈值约 `max_tokens > 21333`)。
  > 设了显式 timeout 之后这道保护就没了 —— 因此 **`max_tokens` 的上限改由本 spec 自行约束**:
  > 非流式路径 `max_tokens` **禁止**超过 **21000**;超过必须走流式(见 §5.4)。

## 2. 请求形状(S1)

```ts
// ★ 必须走 beta 命名空间:fallbacks 只在 client.beta.messages.create 上可用,
//   而 client.messages.parse() 位于非 beta 命名空间且不接受 betas —— 二者不能混用(审核 #003 A1)。
const res = await client.beta.messages.create({
  model: MODEL,                    // models.ts 的 provider-aware 单一出处
  max_tokens: 16000,
  output_config: {
    format: s1OutputFormat(),       // Zod 3 → JSON Schema，调用后仍用 Stage1Out.parse
    effort: 'medium',
  },
  system: [{ type: 'text', text: prompt.text, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: prompt.userText }] }],
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
});
// 结构化输出由调用方自行校验(放弃 parsed_output,换取与 fallbacks 共存)
const parsed = Stage1Out.parse(JSON.parse(textOf(res.content)));
```

规范性条文:

1. canonical request **必须**使用 `output_config.format`，**禁止**使用已废弃的顶层 `output_format` 参数。由于仓库 contracts 仍是 Zod 3、SDK `betaZodOutputFormat` 只接受 Zod 4，格式由 `zod-to-json-schema` 在 `packages/ai` 内生成；Anthropic 适配为 `client.beta.messages.create()`，DeepSeek 适配为 Responses `text.format`。返回内容**必须**再经 `Stage1Out.parse()` 校验；校验失败按 §5.4 处理。

   > **为什么不用 `client.beta.messages.parse()`** —— 它确实存在,也确实能与 `betas`/`fallbacks` 共存(实现期核实,修正了审核 #003 A1 中"非 beta 命名空间"的表述):因为**注入点必须落在 wire 边界上**([99](./99-acceptance.md) §0)。`parse()` 在 SDK 内部做了一层客户端解析,把注入点放在它之上,录制盒里存的就不再是 API 的原始响应,而是 SDK 加工过的产物 —— 那样的回放证明不了"我们对真实响应的处理是对的"。用 `create()` + 自行 `Stage1Out.parse()`,录制盒 = 原始响应,回放才是诚实的。
   > 代价是放弃 `parsed_output` 的类型便利。这个代价换的是验收资产的可信度,值。
2. **禁止**传 `thinking` 的 `budget_tokens`(Opus 5 上返回 400)。**禁止**显式 `{type:'disabled'}`。省略 `thinking` 即为 adaptive,这是本项目要的行为。
3. `output_config.effort` **必须**为 `'medium'`。理由:S1 是抄写与分类任务,不是推理任务;更高档位只增加成本与延迟。
4. `max_tokens` **必须**为 16000(`full_text` 可能很长,但不得超过 §1 定的 21000 非流式上限)。`stop_reason === 'max_tokens'` 时的提额重试见 §5.4 —— **该重试必须走流式**。
5. **禁止**使用 assistant 预填(Opus 5 上返回 400)。

## 3. 图像块的构造(ADR-050)

1. 图像块**必须**引用 `derived/{slug}/{short_id}/ai-NN.webp` 的预签名 URL,有效期 **必须** ≥ 900 秒。**禁止**引用 L1 原件,**禁止**用 base64(请求体膨胀 1/3)。
2. `ai` 变体的生成规则(执行层,确定性):按 EXIF `Orientation` 旋正 → `fit: 'inside'` 缩到长边 ≤ **2576** px、不放大 → WebP **质量 92** → 剥除全部 EXIF/ICC。
   > 质量取 92 而非 `preview` 的 82:官方明确警告有损压缩会让小字难以辨认,而这一层唯一的消费者是 OCR。
3. **图像块必须排在文本块之前**(官方指引:image-then-text 效果最好)。
4. 多页文档一次调用送多页时:
   - **必须**按 `page_no` 升序送(ADR-047:`page_no` 是语义页序;M2 仍等于 `capture_order`,不得依赖这个巧合)。
   - 所有 image 块之后**必须**追加唯一文本块，按图像出现顺序列出 `第 N 页` 映射；其中 **N 必须是全局 `page_no`,不是批内序号**(审核 #003 A7)。prompt 中须显式说明"页号已给出,直接采用,不要自行编号"。
   - **单次请求的 image 块数量必须 ≤ 20**。超过 20 会触发更严的逐图尺寸限制(每张 ≤ 2000 px),使 `ai` 变体的 2576 px 失效。页数 > 20 的文档**必须**分批调用,每批 ≤ 20 页,并在 [03](./03-stage1.md) §5 合并。
5. **PDF 页禁止走 image 块**。图片格式仅限 JPEG/PNG/GIF/WebP。PDF **必须**以 `document` 块提交(base64,单请求 ≤ 32 MB、≤ 600 页);超限的 PDF 记为 `unsupported` 并进人工队列。

## 4. Prompt 版本管理

1. Prompt **必须**以文件形式存放于 `packages/ai/prompts/{stage}/{id}@{version}.md`,`version` 为**单调递增整数**。**禁止**在 TypeScript 源码中内联 prompt 正文。
2. 每个 prompt 文件在构建时被读入并计算 `sha256`。运行时 **必须** 校验 `sha256` 与清单 `packages/ai/prompts/manifest.json` 一致,不一致则**启动失败**。
   > 理由:prompt 是提取行为的一部分。改了 prompt 而版本号没动,等于让两批数据的产出口径不同却无从分辨。
3. 每次调用的产物 **必须** 记录 `prompt_id`、`prompt_version`、`prompt_sha256`、`model`、`effort`,并写入 S1 工件(见 [03](./03-stage1.md) §4)。**没有这四项的工件视为不可信,重跑工具必须拒绝复用。**
4. **缓存纪律**:`cache_control` 只放在 system 块上;system 块内容**必须**逐字节稳定 —— **禁止**在其中插入时间戳、文档 id、人名、页数等任何随请求变化的内容。所有易变内容**必须**放进 `messages` 的文本块。
   - 最小可缓存前缀约 **1024 token**;S1 prompt 必须超过该长度,否则缓存静默失效。
   - 验收断言:连续两次同 prompt 调用,第二次 `usage.cache_read_input_tokens > 0`([99](./99-acceptance.md) B3)。

## 5. 拒绝与降级

1. **必须**在读取 `content` 之前先检查 `stop_reason`。
2. `stop_reason === 'refusal'`:**必须**读取 `stop_details.category` 与 `explanation` 并原样记入 job 的失败详情。该 job **必须**转入 `needs_human` 终态,**禁止**自动重试(重试同一输入只会再次被拒)。
3. Anthropic 路径**必须**启用服务端 fallback:`betas: ['server-side-fallback-2026-07-01']` + `fallbacks: 'default'`；DeepSeek Responses 当前忽略这两个 Anthropic 专用字段。两条路径都**必须**把实际服务模型 `response.model` 记入工件。
4. 错误分类(与 m1-04 §3 同构,但这里是服务端到服务端):

| 情形 | 处置 |
|---|---|
| `RateLimitError`(429) | 可重试,全抖动退避,最大 5 次 |
| `APIConnectionError` / 5xx | 可重试,同上 |
| `stop_reason === 'max_tokens'` | **以流式** `client.beta.messages.stream(...)` + `.finalMessage()`、`max_tokens: 32000` 重试一次;再失败 → `needs_human`。**禁止**非流式重试 —— 32000 tokens 的预期生成时间约 900 秒,而客户端 600 秒就 abort,SDK 会再自动重试两次同样注定超时的调用(每次都产生已计费输出),最终终态退化为 `failed` 而非本表承诺的 `needs_human`(审核 #004 A-8) |
| S3 `PreconditionFailed`(412:同 `prompt_version` 的工件已存在) | **读取既有工件、跳过模型调用、直接落库**。成因是"PUT 工件成功但 DB commit 前进程崩溃"后的重跑;工件其实是好的,重新调模型纯属浪费(审核 #004 B-12) |
| `stop_reason === 'refusal'` | **终态** `needs_human`,不重试 |
| `BadRequestError`(400) | **终态** `failed`,不重试(请求形状错误,重试不会自愈) |
| 输出未通过 Zod 校验 | 重试一次;再失败 → `needs_human` |

5. **禁止**任何"失败就静默跳过"的路径。每个终态**必须**在 `ai_job` 表留下可查询的原因。
6. **两处"重试一次"必须在同一次取件内同步完成,不经过 `pending`**(审核 #004 B-8)。否则 worker 每次取件都认为"这是第一次",永远走不到 `needs_human`,而是烧满 5 个 attempt 后判 `failed` —— `ai_job` 表里没有任何字段能承载"这是第二次"(`attempt` 同时被退避与僵尸回收使用)。

## 6. 成本与批处理

1. 单页视觉 token 按 `⌈w/28⌉ × ⌈h/28⌉` 计;2576×1449 约 4784 token,Opus 5 输入 $5/M ⇒ 约 **$0.024/页**。实现**必须**把每次调用的 `usage` 原样记入工件,使成本可事后核算。
2. 存量补跑(用户集中扫描旧单据的场景)**应当**走 Batch API(`client.messages.batches`,成本 50%)。M2 **必须**实现单条实时路径;批处理路径**可以**在 M2 内实现,若实现则:
   - **必须**按 `custom_id` 关联结果,**禁止**按返回顺序关联(结果顺序无保证)。
   - **禁止**在批处理请求中使用 `fallbacks`(该参数在 Batches API 上被拒)。
