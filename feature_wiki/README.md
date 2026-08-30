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

本目录只记录已实现并有代码或验收证据的用户、审核者和运维人员可见行为。功能已在当前工作树实现不等于已提交/发布，发布状态单独标明。

## 当前页面

- [账号注册与首次本人档案](./account-registration.md) — 已交付；支持自助注册、自动建档和直接登录。
- [账户中心、退出与账户注销](./account-management.md) — 已交付；提供账户信息、退出登录及带撤权审计的匿名化注销。
- [采集、离线队列与档案浏览](./capture-archive-and-browse.md) — 已交付；原 M1 自动验收 88/88，家庭成员创建补录已通过浏览器冒烟、待所有者确认。
- [AI 元数据与后台作业](./ai-metadata-and-jobs.md) — M2 进行中；Stage 1、归一/归组、人工纠正、文档边界和人工层回放已实现，完整 A/B 编排与 C 组基线尚未交付。
- [P0–P4 Core：情境、数据、趋势与导出](./core-context-data-trends-and-exports.md) — 当前工作树已实现，`PROCESSING_MODE=off` 自动验收通过；项目所有者/医生人工 gate 与提交发布待完成。

## 当前产品边界

- 产品定位是个人与家庭病历归档，不提供诊断、治疗建议或医学结论。
- Core 价值从弱网归档延伸到情境、人工结构化事实、关键词检索、趋势和确定性导出，均不需要 AI。
- AI/ASR/OCR/语义检索是可选、可替换、可整体不部署的辅助插件；未确认建议不进入趋势或导出。

## 维护规则

功能、流程、权限、配置或用户可见降级发生变化时，更新稳定 slug 对应的页面。实现状态以代码和验收为准，不以路线图中的待办框为准。
