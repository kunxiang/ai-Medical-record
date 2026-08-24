---
title: "AI 病历 — 功能知识索引"
category: feature
tags: [medical-record, archive, index]
status: shipped
module: platform
audience: [user, operator, reviewer]
since: 2026-08-18
owners: ["ai-medical-record"]
routes:
  - "/"
sources:
  - "docs/11-deployment.md"
  - "specs/m1/RESULTS.md"
  - "apps/web/src/App.tsx"
---

# 功能知识索引

本目录只记录已实现并有代码或验收证据的用户、审核者和运维人员可见行为。规划中的 M3+ 能力不写成现有功能。

## 当前页面

- [采集、离线队列与档案浏览](./capture-archive-and-browse.md) — 已交付；M1 自动验收 88/88。
- [AI 元数据与后台作业](./ai-metadata-and-jobs.md) — M2 进行中；Stage 1、作业队列和归人对账已可运行，归一/归组/纠正/回放尚未交付。

## 当前产品边界

- 产品定位是个人与家庭病历归档，不提供诊断、治疗建议或医学结论。
- 已交付的核心价值是弱网采集、可靠归档和按人浏览。
- 情境问答、全文检索、结构化指标、趋势和导出属于后续里程碑，当前不可用。

## 维护规则

功能、流程、权限、配置或用户可见降级发生变化时，更新稳定 slug 对应的页面。实现状态以代码和验收为准，不以路线图中的待办框为准。
