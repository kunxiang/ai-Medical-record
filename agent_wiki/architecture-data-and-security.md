---
title: "架构、数据分层与安全边界"
kind: engineering
status: active
scope: repository
verified_on: 2026-08-24
owners: ["ai-medical-record"]
sources:
  - "docs/01-architecture.md"
  - "docs/02-repo-structure.md"
  - "docs/04-storage-layout.md"
  - "apps/api/src/access.ts"
  - "apps/api/src/define-route.ts"
---

# 架构、数据分层与安全边界

## 系统形态

项目是 pnpm workspace TypeScript monorepo：

- `apps/web`：React/Vite PWA，负责采集、展示和 IndexedDB 离线队列。
- `apps/api`：Fastify 长驻 API，负责鉴权、归档、派生物生成和 AI 作业编排。
- `packages/contracts`：跨端 Zod/API 契约和事件 schema 的唯一来源。
- `packages/storage`：S3 key、sidecar 和规范化序列化。
- `packages/ai`：模型调用、版本化 prompt、Stage 1 输出与合并规则。
- `tools`：部署、验收、存储探针和重建工具。

依赖方向是 `apps/* → packages/*`；`packages/*` 禁止反向依赖应用，Web 与 API 只通过 contracts 通信。实际目录优先于早期设计文档中的规划目录。

## 数据层级

| 层 | 内容 | 可变性与恢复 |
|---|---|---|
| L1 档案层 | 原件、拍摄事实、人工输入、journal、manifest | 既有对象字节不可修改；人工判断随写随双写；必须可独立迁移和重建 |
| L2 数据处理层 | 派生图片、AI 工件、AI job、可重算元数据 | 可整体删除和重跑；不得反向修改 L1 |
| L3 分析层 | 后续分析与模型能力 | 可替换；当前 M2 不实现医学分析 |

持久真相是对象存储中的 L1 原件与 sidecar。PostgreSQL 是可重建索引；“可重建”成立的前提是每一项人工判断都进入 L1，而不是只留在数据库。

## 不可协商约束

1. 原件字节零改动；派生物只能写入 `derived/`。
2. AI 读取 L2 派生物，不读取或改写 L1 原件。
3. AI 输出可重跑，人工判断不可因重跑被覆盖。
4. M2 禁止 Stage 2、医学判断、检索、趋势和导出。
5. 归人由用户在采集端确认；AI 只做事后对账，禁止自动修改 `document.person_id`。
6. 新对象类型必须先进入存储权威矩阵；新 journal 事件必须同步 schema、registry 和 `_meta/README.md`。
7. 归一化的语义判断可以由 AI 完成，但执行必须是确定性代码并保留决策依据。

## 权限边界

- 所有业务数据按 `person_id` 归属，通过 `person_access` 授权。
- 角色等级为 `viewer < editor < owner`。
- `requirePersonAccess` 与 `requireDocumentAccess` 是核心检查点。
- 不存在、无授权、权限不足或档案已归档统一表现为 404，避免泄露资源是否存在。
- 浏览器使用 Bearer JWT；AI 密钥只能存在于 API 进程。

## 部署约束

- Web 是静态 PWA，可部署到 Vercel 等静态平台，但必须使用 HTTPS。
- API 必须运行在长驻容器：worker 依赖定时轮询，Stage 1 可能长时间运行，并使用 PostgreSQL 长连接和 Sharp。
- PostgreSQL 要求 16+；对象存储必须支持预签名 PUT、CORS、`If-None-Match` 与 `If-Match` 条件写。
- `WEB_ORIGIN` 必须是精确白名单，禁止 `*`。
- R2 当前不提供对象版本化和逐对象保留锁；投入生产 L1 前必须落实 ADR-048 补偿措施。

## 验证入口

- 类型与单测：`pnpm typecheck`、`pnpm test`
- M1 自动验收：`pnpm m1:acceptance`
- 部署冒烟：`pnpm --filter @amr/tools deploy-smoke`
- 存储能力探针：`pnpm --filter @amr/tools probe-storage`

## 证据

- [系统架构](../docs/01-architecture.md)
- [仓库结构与依赖规则](../docs/02-repo-structure.md)
- [存储布局与权威矩阵](../docs/04-storage-layout.md)
- [当前部署范围与限制](../docs/11-deployment.md)
