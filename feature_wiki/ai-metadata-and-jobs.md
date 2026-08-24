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
sources:
  - "packages/ai/src/stage1.ts"
  - "apps/api/src/jobs/queue.ts"
  - "apps/api/src/jobs/worker.ts"
  - "apps/api/src/jobs/stage1-handler.ts"
  - "apps/api/src/routes/ai.ts"
  - "apps/api/src/routes/browse.ts"
  - "docs/11-deployment.md"
---

# AI 元数据与后台作业

## Purpose

文档登记后异步读取分类、日期、机构原文、科室、患者姓名和全文，并把模型识别到的姓名与采集时用户选择的人员做确定性对账。

该能力处于 M2 rollout，不是完整 M2 发布说明。

## Scope

- 已实现：Stage 1 图片路径、版本化 prompt、分批调用、L2 工件、job 状态机、失败重试、显式 rerun、归人确定性对账和 AI/job 查询 API。
- 未实现：正常 PDF Stage 1、facility 归一、encounter 建议、人工确认/纠正、人工层回放和 M2 总验收。
- 明确不做：Stage 2 化验值提取、单位换算、医学判断、检索、趋势和导出。

## API / Behavior

- 文档登记事务内创建唯一 `stage1` job；重复投递不会创建第二行。
- worker 使用 PostgreSQL `FOR UPDATE SKIP LOCKED` 取件，15 分钟未释放的 running job 会被回收。
- 可重试失败采用有抖动退避；refusal、无有效文本和持续超长输出进入人工终态。
- `GET /api/v1/documents/:id/ai` 返回派生元数据和 job 状态，禁止返回 `full_text`。
- `GET /api/v1/jobs` 支持 `state`、`kind` 和游标过滤，结果受 `person_access` 限制。
- `POST /api/v1/documents/:id/ai/rerun` 需要 editor 权限，把 job 重置为 pending；旧工件不在该端点中删除。

## Data / Model

- 模型输入是旋正、去元数据的 `ai-NN.webp` L2 派生物，不是 L1 原件。
- Stage 1 工件记录 model、prompt id/version/hash、effort、usage 和 batches。
- `full_text` 只存在于 extraction 工件，不写数据库，也不从 AI 状态 API 返回。
- `person_check` 是可重算 L2；`person_check_ack_at` 是人工 L1，两列不能互相覆盖。
- AI 只能产生 `match | mismatch | unknown` 对账结果，禁止修改 `person_id`。

## Operation Guide

1. 确认 API 进程配置 `ANTHROPIC_API_KEY`，并保持 `AI_JOB_WORKER` 开启。
2. 正常登记图片文档；系统自动创建 Stage 1 job。
3. 使用 `/api/v1/jobs` 或 `/api/v1/documents/:id/ai` 查看状态和失败原因。
4. 仅在确认需要重跑时调用 rerun 端点。
5. PDF 当前会进入 `unsupported`；不要把它当成采集失败，L1 原件仍已归档。

## Verification

- 检查登记事务回滚时 job 也不存在。
- 检查模型请求只引用 `derived/**/ai-NN.webp`。
- 检查工件字段齐全、数据库无全文、`person_id` 在 Stage 1 前后逐字节相同。
- 检查无权限与不存在文档的 AI 路由都返回不可区分的 404。
- M2 总验收脚本尚未落地，因此不得宣称 M2 已完成。
- 发布并完成知识索引后，由项目所有者验证搜索“归人从不静默默认”能命中本页。

## Risks and Fallback

- 未配置 AI key 时，采集和浏览仍可用；AI job 失败并保留可见状态。
- 正常 PDF AI 路径未实现，当前终态为 `unsupported`。
- `facility_normalize` 和 `encounter_suggest` handler 当前未实现，worker 会明确写 `needs_human`，不会静默跳过。
- AI 结果属于可重建层；任何人工处理在 journal/replay 完成前都不能被视为完整交付。

## Change Log

- 2026-08-21：Stage 1、job 队列、S1 落库和归人对账进入可运行状态。
- 2026-08-24：建立 rollout 功能知识页，并登记当前限制。
