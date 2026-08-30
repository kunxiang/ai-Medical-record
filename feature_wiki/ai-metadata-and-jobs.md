---
title: "AI 病历 — AI 元数据与后台作业"
category: feature
tags: [ai, metadata, stage1, jobs, reconciliation]
status: in-rollout
module: api
audience: [operator, reviewer]
since: 2026-08-21
owners: ["ai-medical-record"]
routes:
  - "/api/v1/documents/:id/ai"
  - "/api/v1/documents/:id/ai/rerun"
  - "/api/v1/jobs"
  - "/api/v1/documents"
  - "/api/v1/normalization-decisions"
  - "/api/v1/documents/:id/person-check/ack"
  - "/api/v1/documents/:id/reassign"
  - "/api/v1/documents/:id/split"
  - "/api/v1/documents/:id/merge"
  - "/api/v1/documents/:id/move-page"
sources:
  - "packages/ai/src/stage1.ts"
  - "apps/api/src/jobs/queue.ts"
  - "apps/api/src/jobs/worker.ts"
  - "apps/api/src/jobs/stage1-handler.ts"
  - "apps/api/src/routes/ai.ts"
  - "apps/api/src/routes/browse.ts"
  - "apps/api/src/routes/corrections.ts"
  - "tools/src/rebuild-index.ts"
  - "docs/11-deployment.md"
---

# AI 元数据与后台作业

## Purpose

文档登记后异步读取分类、日期、机构原文、科室、患者姓名和全文，并把模型识别到的姓名与采集时用户选择的人员做确定性对账。

该能力处于 M2 rollout，不是完整 M2 发布说明。

它是可选 processing plugin，不是 P0–P4 Core 的前置依赖。Core 默认 `PROCESSING_MODE=off`；未部署 plugin worker 时归档、情境、人工结构化、关键词检索、趋势和导出仍完整可用。

## Scope

- 已实现：Stage 1 图片路径、版本化 prompt、job 状态机、归人确定性对账、机构归一、二文档就诊归组建议，以及对应的人工确认/拒绝、归人纠正、软归档与文档边界后端接口。
- 已实现：人工 archive/ack/facility+encounter normalization 可仅凭 L1 删库重建；回放不读取 AI 工件、不投递 job、不写回 journal。
- 未实现：文档边界可视化操作 UI、A 组剩余 24 项跨层验收、真实 wire cassette 和 C 组真实单据质量基线。当前 18/42 个 A 场景已自动化、B 组 15/15；弱网大文件 multipart 已在采集链源码实现，发布与 owner 验收状态见采集功能页。
- 插件边界：当前 M2 plugin 不负责 Stage 2 质量、单位换算、医学判断或 Core 导出；相应的手工/确定性 Core 实现见独立功能页。

## API / Behavior

- 文档登记事务内创建唯一 `stage1` job；重复投递不会创建第二行。
- worker 使用 PostgreSQL `FOR UPDATE SKIP LOCKED` 取件，15 分钟未释放的 running job 会被回收。
- 可重试失败采用有抖动退避；refusal、无有效文本和持续超长输出进入人工终态。
- `GET /api/v1/documents/:id/ai` 返回派生元数据和 job 状态，禁止返回 `full_text`。
- `GET /api/v1/jobs` 支持 `state`、`kind` 和游标过滤，结果受 `person_access` 限制。
- `POST /api/v1/documents/:id/ai/rerun` 需要 editor 权限，把 job 重置为 pending；旧工件不在该端点中删除。
- `split`、`merge`、`move-page` 均需要 editor 权限和 `client_operation_id`；重复请求返回首次结果。
- merge/move-page 只允许同一人员的两个活动文档；move-page 不允许把单页源文档变为空，需改用 merge。

## Data / Model

- 模型输入是旋正、去元数据的 `ai-NN.webp` L2 派生物，不是 L1 原件。
- Stage 1 工件记录 model、prompt id/version/hash、effort、usage 和 batches。
- `full_text` 只存在于 extraction 工件，不写数据库，也不从 AI 状态 API 返回。
- `person_check` 是可重算 L2；`person_check_ack_at` 是人工 L1，两列不能互相覆盖。
- AI 只能产生 `match | mismatch | unknown` 对账结果，禁止修改 `person_id`。
- facility 提议可先确定性回填机构，但 UI 明示待确认；同指纹后续文档复用决策，不再调用模型。
- encounter 只在人工确认后创建；无时分的相邻日建议必须显示“判据较弱”。
- 归人纠正不移动 L1 原件，只追加 correction/manifest/journal，并强制按新归属重跑 S1。
- 文档归档默认从列表隐藏，可在“含已归档”视图恢复；直访和原件保持可用。
- 文档边界操作只追加 `page_move` correction 与 journal，不改变 `capture_order` 或任何既有原件字节。
- split 新文档有独立 `capture.json`，其中页面以完整 key 引用源原件；merge 的被吸收文档保留为 0 页软归档记录。
- 改变页号会严格删除源/目标 `derived/{slug}/{short_id}/`，避免旧预览对应到错误页面。

## Operation Guide

1. Core API 保持 provider-neutral；只在需要 assist 时启动独立 `plugin-main`，为它配置 `PROCESSING_MODE=assist`、`AI_PROVIDER` 及对应密钥。
2. 正常登记图片或 PDF 文档；系统自动创建 Stage 1 job。
3. 使用 `/api/v1/jobs` 或 `/api/v1/documents/:id/ai` 查看状态和失败原因。
4. 仅在确认需要重跑时调用 rerun 端点。
5. PDF 以单个 document block 处理；超过 32 MiB、超过 600 页或无法解析时进入 `unsupported`，L1 原件仍保留。
6. 边界接口当前只提供 API；执行后应等待源/目标 Stage 1 重新处理完成再审核 AI 元数据。

## Verification

- 检查登记事务回滚时 job 也不存在。
- 检查模型请求只引用 `derived/**/ai-NN.webp`。
- 检查正常 PDF 请求只有一个 `document` 块、没有 `image` 块；3 页 PDF 输出页号必须为 1/2/3，数据库仍只有一个 `document_page` 行。
- 检查工件字段齐全、数据库无全文、`person_id` 在 Stage 1 前后逐字节相同。
- 检查 split/merge/move-page 前后原件与既有 capture/page sidecar 摘要不变，页号连续且 `capture_order` 不变。
- 检查移页后的预览内容对应新的逻辑页，且同一个 `client_operation_id` 重试不新增 correction。
- 检查无权限与不存在文档的 AI 路由都返回不可区分的 404。
- `pnpm m2:acceptance` 当前运行 18/42 个 A 候选场景与 B 组 15/15；4 个模型盒均为 synthetic，真实 wire 录制前不得把第一批或 M2 宣称为已验收。
- 发布并完成知识索引后，由项目所有者验证搜索“归人从不静默默认”能命中本页。

## Risks and Fallback

- 边界操作目前没有前端入口，需通过受鉴权 API 调用；误操作只能通过新的人工纠正操作表达，不能改写 L1。
- 旧版 encounter decision 若不含 facility 快照，只恢复决策行并进入对账；不能自动猜测外键。新确认记录可完整恢复 encounter 与 `grouping_basis`。
- `PROCESSING_MODE=off` 时 API 不创建 processing job，Web 隐藏辅助入口，不显示错误横幅；Core 功能不降级。
- PDF 超限或损坏只终止 AI 处理，不删除 L1 原件。
- AI 结果属于可重建层；任何人工处理在 journal/replay 完成前都不能被视为完整交付。

## Change Log

- 2026-08-26：新增 split/merge/move-page 后端、派生物失效、幂等台账与 page_move 重建回放。
- 2026-08-21：Stage 1、job 队列、S1 落库和归人对账进入可运行状态。
- 2026-08-24：建立 rollout 功能知识页，并登记当前限制。
- 2026-08-26：机构归一、就诊归组建议、人工审核、归人纠正与软归档进入实现完成/待运行验收状态。
- 2026-08-26：正常 PDF document-block、内部页序校验和 32 MiB/600 页门禁实现完成。
- 2026-08-27：人工层回放与第一批 candidate harness 落地；18/42 个 A 场景自动化、B=15/15。独立审查发现 4 个盒是 synthetic stub，已显式标记 provenance 并撤回第一批验收声明；M2 仍待真实 wire cassette、其余 A 项与延期 C 组基线。
- 2026-08-28：依 ADR-051 将 M2 收敛为独立 plugin qualification；20 份真实脱敏单据延后不阻塞 Core P0–P4。
