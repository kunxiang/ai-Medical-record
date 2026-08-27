# M2 A/B 自动验收覆盖矩阵

最近核对：2026-08-27。权威入口：`pnpm m2:acceptance`。

状态定义：

- **场景演练通过**：隔离 PostgreSQL + MinIO + API 上走真实产品调用链，但当前使用明确标注 `provenance=synthetic` 的离线 stub；可证明确定性业务编排，不能替代真实 wire cassette 前置。
- **正式集成通过**：场景演练通过，且模型相关路径已由 `provenance=recorded` 的真实供应商响应复核。
- **组件通过**：统一入口会运行相关单元/契约测试，但尚未覆盖验收条目要求的完整跨层结果。
- **待接入**：当前没有足以支持该 A 条目结论的统一自动证据。

## A 组（18/42 场景已自动化；第一批正式验收待真实 wire cassette）

| 状态 | 验收 ID | 当前证据 / 下一缺口 |
|---|---|---|
| 场景演练通过 | A1–A8 | 固定 `p23456/d23456`：Orientation=6 上传、ai 派生、image-then-text、事务回滚、工件/DB、全库列全文扫描、去重投递、僵尸回收；A4 的实际服务模型仍待 recorded cassette |
| 待接入 | A9 | 需要解决“盒内保留合成手机号”与 B14“任何号码命中即失败”的规格冲突后，增加 extraction 外 DB/S3 全量扫描 |
| 场景演练通过 | A9b | 对工件中除 `full_text` 外的全部结构化字段运行独立手机号/身份证正则 |
| 场景演练通过 | A10–A12 | match/mismatch、查询过滤、ack 时间戳、mismatch 保留、姓名快照与 journal 精确行数 |
| 待接入 | A12b–A14 | ack 后 L2 重跑、reassign 的 WORM 证据和删库后最后写入者胜 |
| 组件通过 | A14b | PDF document block 与 1/2/3 页序已测；尚缺真实 3 页 PDF 的 DB/S3 worker 集成 |
| 场景演练通过 | A15–A17 | transport 增量证明 facility 首次调用、同指纹缓存复用、人工确认及 decisions L1 流 |
| 组件通过 | A18a–A19b | 候选时窗四分支已单测；尚缺 worker/提议表集成，A19a 还需与并行 UI session 合并后验证“判据较弱” |
| 待接入 | A20 | 已有 archive/replay 子集；仍缺默认列表/直访/派生物/audit/L1 版本的整条证据 |
| 组件通过 | A21 | split 规划与 contracts 已测；尚缺真实对象、幂等和页序集成 |
| 待接入 | A21b | split 后删库重建 |
| 组件通过 | A22 | multipart 规划、浏览器缺片恢复与服务端校验逻辑已测；尚缺真实 12 MiB 中断刷新链 |
| 组件通过 | A23–A26 | refusal/max_tokens/25 页 merge/PDF 上限各有组件测试；尚缺 job 终态、工件和 `/jobs` 集成 |
| 待接入 | A27–A29 | L2 整体重算、版本证据与 M2 三个越权端点 |
| 组件通过 | A30 | `parseKey` 含 `derived/_meta` 性质测试已过；尚缺隔离桶五个前缀的全量扫描 |
| 待接入 | A31–A32c | 日期 NULL 边界与 merge/move-page/预览内容的真实 DB/S3 集成 |
| 集成通过 | A33–A35 | 人工层删库恢复、rebuild 期间零 AI 增量调用、二次重建幂等且不写回 L1；不依赖模型响应 provenance |

## B 组（15/15 自动通过）

| 验收 ID | 证据 |
|---|---|
| B1–B2 | `tools/src/ci-deps.ts` 按 CHANGES #14 检查包边界，并同时扫描 `claude-*` / `deepseek-v*` 默认模型 ID 单一出处 |
| B3 | 连续构造的 system 序列化字节相同，`cache_control` 仅在 system |
| B4 | prompt 故障注入完整性测试 |
| B5 | 隔离桶中的 journal/decision schema、registry、README 三处逐项核对 |
| B6–B7 | contracts/迁移 CHECK 同步与 `drizzle-kit generate` 漂移探针 |
| B8–B9 | 调用方 `event_id` 保留回归；Stage1 根对象和全部嵌套对象 strict 故障注入 |
| B10–B12 | Stage 2 泄漏扫描、ai 派生确定性、merge 三类性质测试 |
| B13–B15 | L1 字段恢复比对、4 个 cassette 独立 PII 扫描、rebuild L2 引用禁令 |

当前 4 个 cassette 均明确标记为 `provenance=synthetic`，只服务于离线工程场景。正式第一批验收还需用不含真实 PII 的合成图进行一次供应商真实调用，生成 `provenance=recorded` 的 response ID/model/usage 基准；这与 C 组 20 份真实单据收集是两个独立事项。

## 延后但未豁免

C1–C9 的至少 20 份真实脱敏单据由项目所有者继续收集。该项不阻塞上述 A/B 工程推进或候选发布，但仍阻塞 M2 最终关闭；合成 cassette 不计入 C 组。
