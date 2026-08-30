---
task: p0-p4-core
title: P0-P4 非 AI 核心主线与可插拔智能处理
summary: >-
  让归档、情境、结构化数据、趋势和就诊导出在完全关闭 AI 时仍可端到端使用，
  并把所有模型能力收敛为可替换、可删除、不可阻塞核心发布的辅助插件。
app: ai-medical-record
status: acceptance
progress: p4-implementation-and-automated-gate-complete-manual-gates-pending
priority: high
next_action: owner-and-doctor-manual-gates-then-release-review
created: 2026-08-28
updated: 2026-08-28
---

# P0-P4 非 AI 核心主线

## 用户目标

- 按最初设计文档持续推进至 P4，而不是把 M2 AI 验收当作后续产品阶段的前置条件。
- AI 只提供建议、预填、转写、提取或语义增强；它不是任何 P0-P4 用户价值的唯一实现路径。
- 模型提供方、模型 ID、prompt、调用协议和整套 AI 处理模块都必须可持续替换。
- 模型质量、真实 wire cassette、供应商可用性和 AI 凭证不得成为核心产品发布门禁。

## 当前状态

- 调研完成；核心约束、现有耦合点和替代路径记录于 `docs/research.md`。
- 总体设计、API、数据库、验收和 UX 状态矩阵已经形成。
- 第一轮 UX/业务与技术审查均为 FAIL；经过两轮修订后，最终 Tech 与 UX/Biz 复审均为 PASS，可进入业务实现。
- Core-0 contracts/config、provider-neutral processing persistence/queue 与 API/plugin 进程拆分已实现并通过自动检查。
- Core-0 capability API、Web fail-closed 与独立 `pnpm core:acceptance` 已完成。
- P0 schema/contracts、operation replay/journal、metadata/encounter、legacy suggestion/search、单人 L1 bundle 和 Web 工作台已实现。
- 2026-08-28 隔离 `PROCESSING_MODE=off` 验收：Core/API 47/47、真实浏览器 17/17、contracts 46/46、API 44/44、Web 10/10；单人 ZIP 边界和两轮删库重建等价通过。
- P0 尚待 owner 桌面/手机预览、字段冲突合并人工检查和 P0-11“找旧文档 <60 秒”；因此未标记为正式验收。
- P1 contracts、五套模板、session/answer/media API、journal/rebuild、IndexedDB v2、离线同步和 Context Web 已实现。
- 2026-08-28 最新隔离验收：Core/P0/P1 API 60/60、真实浏览器 26/26、contracts 52/52、API 46/46、Web 10/10；Context 4 session/16 answer/2 media 两轮删库重建等价。
- P1 的 context→Observation 与 context→Medication 显式 promote 已在无 AI 总验收及两轮重建中通过；尚待麦克风拒绝实机检查和 P1-10“采集+5题 <90 秒”，因此未标记为正式人工验收。
- P2 medical package、完整 Observation/alias/schema、稳定来源、batch/correction/archive、mapping inbox、suggestion 接受、journal/rebuild、确定性派生与 Web 工作台已经实现。
- P2 Web 支持原件/表格并排、TSV/CSV、报告级继承、概念目录、复制行、键盘录入、100 行分块、IndexedDB v3 草稿、修正冲突、mapping inbox 和历史建议人工接受。
- 2026-08-28 最新隔离验收：Core/P0/P1/P2 API 72/72、真实浏览器 30/30、contracts 61/61、API 46/46、Web 12/12、medical 13/13、tools 8/8；6 条 L1 Observation、1 条 deterministic derived、1 条 alias 与 34 个 operation 两轮删库重建等价。
- P2 尚待 owner 桌面/手机预览和 P2-10“10 行桌面 ≤3 分钟、移动 ≤5 分钟”人工 gate；20 份真实脱敏单据不属于 Core gate。因此工程主线进入 P3，但 P2 未标记为正式人工验收。
- P3 metric group contracts/schema/migration、用户组/“三高+”副本、revision/archive、journal/rebuild、完整 series 趋势、单位分线、逐点参考区间、RCV、context 中性叠加、来源回链和固定 LTTB 已实现。
- P3 Web 支持自定义监控组、预设复制、排序/归档、日期筛选、0/1/多点状态、不可比单位提示、RCV、逐点来源和 bbox 高亮。
- 2026-08-28 最新隔离验收：Core/P0/P1/P2/P3 API 80/80、真实浏览器 34/34、contracts 65/65、API 46/46、Web 12/12、medical 16/16、tools 9/9；14 条 L1 Observation、1 条 deterministic derived、3 个 metric group/14 items 与 40 个 operation 两轮删库重建等价。
- P3 自动验收已完成；仍需与 P0–P2 一起进行 owner 主观桌面/手机预览。
- P4 medication/timeline contracts、migration、API、journal/rebuild、Core search、context promote、确定性 PDF/PNG renderer、export worker/history/retry/stale/download、owner-only 分享与 Web 导出工作台均已实现。
- 2026-08-28 最终隔离验收：Core/P0–P4 API 100/100、真实浏览器 47/47、contracts 73/73、API 52/52、Web 15/15、medical 16/16、tools/replay 13/13；两轮删库重建等价，最终投影为 3 people、2 documents、2 encounters、4/16/2 context、15 L1 + 1 derived observations、3/14 metric groups/items、5 medications、4 timeline events、53 operations、39 search entries、0 processing jobs/suggestions。
- `pnpm typecheck`、`pnpm test`、`git diff --check` 与 `pnpm core:acceptance` 均通过；最终代码审查对自动化实现为 PASS。发布仍为 CONDITIONAL：P0/P1/P2 的 owner 现场 gate、P4-11 ≤30 秒操作检查和 P4-12 3–5 名医生可读性 gate 尚未执行。
- 人工验收包已落地：正式 renderer 生成的合成 PDF/PNG 样张可字节级重建，`MANUAL-ACCEPTANCE.md` 定义统一计时/真机/医生流程，`core:manual-evidence` 对缺项、阈值、证据引用和 P4-12 真实样本 fail closed。它只降低执行成本，不代替真人证据。
- 样张视觉预检后，renderer 将每个指标的“最新｜”“变化｜”“来源｜”拆为独立扫描行，最新值用主色突出，来源不可用显式标记；相应文案、拥挤 PDF 单页与 PNG 固定画布均有回归测试。

## 规格文件

- 总体设计：`specs/01_design_spec.md`
- API 契约：`specs/02_api_contracts.md`
- 数据库设计：`specs/03_database.md`
- 验收设计：`specs/04_acceptance.md`
- UX 状态矩阵：`specs/05_ux_states.md`
- 第一轮审查：`review-001.md`
- 通过审查：`review-002.md`

## 相关知识

- `agent_wiki/architecture-data-and-security.md`：L1/L2/L3、人工输入双写和恢复约束；hash `4b46ea7d0dec62929b3239e19f45d7fc9f8c5b9a17f27382ff2b40b8ba96ba1b`
- `agent_wiki/runtime/m2-implementation-status.md`：当前 M2 rollout 与验收缺口；hash `d6b6d3748c88dda923b5c498e0eaf81184d561f62d04ea175a88d89817f6758d`
- `feature_wiki/ai-metadata-and-jobs.md`：现有 AI 用户可见行为；hash `014eb7682fd2907f03859ef0b22c2c0070c72b545ae64c2752a754b66b3639cf`
- `feature_wiki/capture-archive-and-browse.md`：已交付归档主链；hash `3e090a44ecfe237cb3dae3bb3c6d12f16c19bda1b0f5579fb5830f75226b7aff`
- `feature_wiki/core-context-data-trends-and-exports.md`：P0–P4 Core 用户可见行为；hash `3db8b4d8cd79b01a8258ff3ba5cab13ab853e8245737c220d646fcd12562d159`
- Context manifest：`docs/context-manifest.yaml`
- 人工验收流程：`MANUAL-ACCEPTANCE.md`；记录模板：`manual-evidence.template.json`

## 规划里程碑

1. **Core-0：解耦门禁与运行时**——无 AI key、无 AI worker、无供应商网络时核心服务正常启动、上传、浏览和编辑；AI 验收移入独立插件资格轨。
2. **P0 完整归档**——人工元数据、文档详情、确定性筛选/关键词检索、原件与单人 L1 bundle 导出；AI 只增强自动预填和 OCR 命中。
3. **P1 情境记录**——版本化模板、点选/文字/日期/数字回答、可跳过和续答；录音可保存，ASR 与 AI 追问均可关闭。
4. **P2 结构化提取**——人工录入/校正 observation 是核心路径；确定性单位换算和校验；AI 结构化结果只是待确认建议。
5. **P3 指标趋势**——只消费人工录入或已人工确认的数据，确定性生成趋势、参考区间、RCV 和来源回链。
6. **P4 就诊导出**——确定性生成一页纸趋势与事件时间轴，可附原件；不依赖、也不包含 AI 结论。

## 硬约束

- 归人仍是录入时唯一强制确认，且始终由人完成。
- L1 原件、拍摄事实和人工输入自足；AI 产物只进入可删除的 L2/L3。
- 未确认的 AI 建议不得进入趋势、导出或其他核心事实投影。
- 关闭 AI 后不得制造失败 job、错误横幅或残缺的核心导航。
- 不诊断、不治疗建议、不把报告参考区间替换为全局“正常值”。

## 审查记录

- 2026-08-28 Review 001：FAIL。使用两个独立 Codex reviewer（Tech、UX/Biz），未使用外部 advisor；MCP-LSP 未暴露，使用 `rg` + 定点源码阅读 fallback。
- 主要阻断：离线 context、非 AI concept mapping、字段级 suggestion provenance、完整 observation/稳定 page identity、medication、通用幂等与 revision、安全媒体上传、可恢复 export queue、旧 family job 迁移、统一 search projection。
- 2026-08-28 Revision 001：上述 blocker 已进入 `01..05` 规格；待 Review 002。
- 2026-08-28 Review 002：Tech PASS、UX/Biz PASS；设计审查通过，允许编码。
- 2026-08-28 Code Start：已生成 `tasks.md`；`REQUIRED_SKILL_ROUTE=fullstack`，执行策略 `codex_local`，从 Core-0 开始。
