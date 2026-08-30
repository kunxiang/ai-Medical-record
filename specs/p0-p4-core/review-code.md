# P0–P4 Core Final Code Review

日期：2026-08-28  
审查范围：当前工作树中的 Core-0、P0、P1、P2、P3、P4 实现与验收资产  
自动化实现结论：**PASS**  
发布结论：**CONDITIONAL — 等待 owner/医生人工 gate**

## 审查方法

- 以 `review-002.md`、`specs/01_design_spec.md`、`specs/02_api_contracts.md`、`specs/03_database.md`、`specs/04_acceptance.md` 和 `specs/05_ux_states.md` 为权威设计输入。
- 按 completeness、correctness、coherence 三个维度核对 contracts/schema/service/routes/Web/journal/rebuild/acceptance 的闭环。
- 当前运行面未提供 MCP-LSP；按既定 fallback 使用 `rg`、定点源码阅读、全仓 TypeScript typecheck、Vitest、真实 Chromium 与隔离端到端验收。
- 检查仓库中的 `TODO/FIXME/HACK/@ts-ignore/as any`、硬编码密钥和无关调试输出；未发现进入产品路径的遗留项或提交到仓库的 provider key。验收脚本中的 `console.log/error` 为测试报告输出。

## Completeness

| 里程碑 | 代码与自动验收 | 结论 |
|---|---|---|
| Core-0 | processing mode/capability、API/plugin/export 进程分离、依赖边界、off 模式 | 完整 |
| P0 | 人工 metadata、encounter、search/detail、legacy suggestion、单人 L1 bundle、Web | 完整；人工耗时/主观 gate 待执行 |
| P1 | 版本化 context、八类回答、安全媒体、离线恢复、显式 promote、重建 | 完整；麦克风拒绝与耗时 gate 待执行 |
| P2 | observation、mapping、稳定来源、确定性派生、workbench、重建 | 完整；人工录入耗时 gate 待执行 |
| P3 | metric group、严格 series、单位/参考/RCV、来源回链、LTTB、Web | 完整；owner 主观预览待执行 |
| P4 | medication/timeline、确定性 export、worker/history/retry/stale、分享、Web | 完整；P4-11/P4-12 人工 gate 待执行 |

每个新 L1 写路径均具有 strict contract、person/access 校验、operation/revision 语义、journal registry、rebuild 投影和自动验收。P4 导出及分享属于可重建 L2；未确认 AI suggestion 不进入 search/trend/export。

## Correctness

- `PROCESSING_MODE=off` 环境未创建旧/新 AI job，Core API、Web、导出 worker、关键词检索、趋势和分享仍完整工作。
- 无权限与不存在在 search/detail/context/media/facts/export 路径统一为 404；P4 自动化覆盖 owner/editor/viewer 角色矩阵。
- medication、timeline、context promote、observation、metric group 的 operation ledger 与两轮删库重建逐字段等价。
- export manifest 使用 canonical JSON、固定 renderer/font manifest/source revision；同一输入 PDF/PNG 字节和 hash 稳定，事实变更只把历史工件标为 stale。
- 分享明文 token 只在首次响应出现，服务端持久化 hash；过期、撤销、未知统一 404，公开响应 `no-store`，通用文件名且具 token-hash/IP 限流。
- 拥挤 PDF 限制为一页；PNG 固定 1240×1754，潜在布局越界会显式失败，未展开指标/事件/缺口显示剩余计数。

## Coherence 与本轮修正

本轮审查发现并修复两项 correctness 问题，修复后均有回归证据：

1. Web 权限角色未知时曾允许已完成工件下载；现改为 fail-closed，并在切换 person 时重新挂载导出面板，避免上一人物的角色/历史短暂残留。
2. renderer 曾可能让 PDF 扩为多页、PNG 在固定画布底部静默截断；现限制首屏展开量、截断超长文本、显示剩余计数，并为 PDF 单页和 PNG 固定画布增加回归测试。

未发现 blocker、重复体系、影子实现、死抽象或以 AI 为 Core 必要依赖的回归。Vite 仍报告现有 IndexedDB 模块同时被静态/动态导入和 bundle 大于 500 kB；它们是性能/拆包优化项，不影响本次 P0–P4 功能与正确性结论。

## 验证证据

- `pnpm typecheck`：7 个 workspace package 全部通过。
- `pnpm test`：全仓通过；关键计数为 contracts 73/73、API 52/52、Web 15/15、medical 16/16、tools/replay/manual-evidence 13/13。
- `pnpm core:acceptance`：Core API 100/100、真实 Chromium desktop/mobile 47/47、依赖边界与单人 ZIP 边界通过。
- 两轮 delete/rebuild 等价：3 people、2 documents、2 encounters、4/16/2 context、15 L1 + 1 derived observations、1 alias、3/14 metric groups/items、5 medications、4 timeline events、53 operations、39 search entries、0 processing jobs/suggestions。
- `git diff --check`：通过。
- 审查后补充的人工验收包已通过全仓 typecheck/test；样张连续生成 hash 一致，PDF 1 页、PNG 1240×1754，空证据模板按预期返回 `INCOMPLETE`。
- P4-12 预检进一步把最新值、变化与来源拆成独立显式标签并补回归；此启发式改进不被冒充为医生人工通过。

## 发布前剩余 gate

- P0-11：已知样例找旧文档 `<60 秒`，以及桌面/手机主观预览、字段冲突人工检查。
- P1-6/P1-10：手机拒绝麦克风后的文字降级；拍摄加 5 题 `<90 秒`。
- P2-10：10 行人工事实桌面 `≤3 分钟`、移动 `≤5 分钟`。
- P3：owner 桌面/手机趋势主观预览。
- P4-11：owner 从 preview 到下载 `≤30 秒`，核对实际 PDF/PNG 内容。
- P4-12：3–5 名医生使用脱敏样例验证“3 秒定位”；这是 P4 发布硬门槛。
- 部署后抽查实际访问日志不含 share token、person 名称或原文件名。

20 份脱敏真实单据继续属于可选 AI plugin/现场质量基线，不是上述 Core gate。当前代码尚未提交、合并或发布。
