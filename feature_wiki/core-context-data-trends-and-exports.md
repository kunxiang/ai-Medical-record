---
title: "AI 病历 — P0-P4 Core 情境、数据、趋势与导出"
category: feature
tags: [core, context, observation, medication, trend, export, share]
status: implemented-unreleased
module: fullstack
audience: [user, operator, reviewer]
since: 2026-08-28
owners: ["ai-medical-record"]
routes:
  - "/api/v1/search"
  - "/api/v1/context"
  - "/api/v1/people/:person_id/observations"
  - "/api/v1/people/:person_id/medications"
  - "/api/v1/people/:person_id/metric-groups"
  - "/api/v1/exports"
sources:
  - "specs/p0-p4-core/RESULTS.md"
  - "apps/web/src/features/context"
  - "apps/web/src/features/data"
  - "apps/web/src/features/trends"
  - "apps/web/src/features/exports"
  - "tools/src/core-acceptance.ts"
---

# P0–P4 Core：情境、数据、趋势与导出

## Purpose

在完全关闭 AI 时，仍能从归档进入情境记录、人工结构化事实、确定性趋势和就诊摘要；所有数值和事件保留来源，不生成诊断、风险评估或治疗建议。

## Scope

- P0：人工 metadata/encounter、文档详情、Core keyword search、单人 L1 bundle。
- P1：五套版本化模板、八类回答、离线续答、音频/照片 L1、文字替代、显式 promote。
- P2：手工 observation 批量录入/修正/归档、本地 concept mapping、单位换算和确定性派生。
- P3：用户监控组、严格 series 分线、参考区间、RCV、context 中性叠加、来源回链。
- P4：medication/timeline，PDF/PNG preview/generate/progress/retry/stale/history/download，owner-only 分享/撤销。

当前状态是“工作树已实现、无 AI 自动验收已通过、尚未提交/发布”。项目所有者耗时/真机 gate 和 3–5 名医生的导出可读性 gate 仍待执行。

## API / Behavior

- `GET /api/v1/capabilities` 公开报告 Core/assist 姿态；Web 对未知能力 fail-closed。
- keyword search 总是 Core；semantic/hybrid 无能力时返回 `capability_unavailable`，不静默降级或伪装命中。
- context `maps_to` 只用于预填；用户提交完整 draft 并显式确认后，才可 promote 为 observation/medication。
- 趋势只读未归档 confirmed/corrected 事实和可证明的确定性派生；未确认 suggestion 不进入。
- export worker 冻结 canonical input 和 renderer/font/version hash；产物丢失可重生，来源 revision 变化显示 stale。
- viewer 只能查看已完成历史/下载，editor 可 preview/生成/重试，owner 额外可分享/撤销。
- 分享明文 token 只返回一次，服务端仅存 hash；过期/撤销/未知统一 404，公开响应 `private, no-store`。

## Verification

- `pnpm typecheck`
- `pnpm test`
- `pnpm core:acceptance`（显式 `PROCESSING_MODE=off`，真实 Chromium，PDF/PNG 下载/公开分享，两轮删库重建）
- 自动数字、未执行的人工 gate 和发布状态以 [`specs/p0-p4-core/RESULTS.md`](../specs/p0-p4-core/RESULTS.md) 为准。

## Risks and Fallback

- Core 不受 provider 停机、密钥缺失或 M2 质量基线延后影响；这些只隐藏 assist 入口。
- 导出不应解读数据。它只展示已确认事实、时间精度、参考区间、中性变化和来源缺口。
- 20 份脱敏真实单据是延后的 plugin/field quality 基线，不能用来否决 Core 功能交付。

## Change Log

- 2026-08-28：创建 P0–P4 Core 功能页，记录无 AI 闭环、角色矩阵、导出/分享安全与未完成人工 gate。
