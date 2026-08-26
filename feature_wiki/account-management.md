---
title: "AI 病历 — 账户中心、退出与账户注销"
category: feature
tags: [account, authentication, logout, privacy, deletion]
status: in-rollout
module: platform
audience: [user, operator, reviewer]
since: 2026-08-26
owners: ["ai-medical-record"]
routes:
  - "/"
  - "/api/v1/account"
sources:
  - "packages/contracts/src/auth.ts"
  - "apps/api/src/routes/auth.ts"
  - "apps/api/src/define-route.ts"
  - "apps/api/src/db/schema.ts"
  - "apps/web/src/features/account/AccountView.tsx"
  - "apps/web/src/offline/db.ts"
---

# 账户中心、退出与账户注销

## Purpose

让登录用户查看自己的账户资料、安全结束当前浏览器会话，并在理解医疗档案保留边界后永久注销登录账户。

## Scope

- 已支持：查看邮箱、显示名称、时区和注册时间；退出当前浏览器；输入当前密码并二次确认后注销账户；注销后清除当前浏览器的本地队列和缓存。
- 不支持：编辑账户资料、恢复已注销账户、选择性保留某个档案权限、立即物理销毁受治理锁保护的病历与审计记录。

## API / Behavior

- `GET /api/v1/account` 返回当前账户的只读资料。
- 退出登录是客户端会话操作：清除本地 Bearer token 并暂停上传队列；已有服务端档案不受影响，本机待上传原件继续保留供同一账户重新登录后上传。
- `DELETE /api/v1/account` 要求 `current_password` 与固定确认值 `DELETE`。密码不正确返回 `401 unauthenticated`。
- 注销成功后，账户写入 `archived_at`、邮箱和显示名称被匿名化、密码散列被替换、`token_epoch` 递增；所有旧令牌立即失效，原账户不能再次登录。
- 账户的每项档案授权先写 `access_revoke` 审计，再删除 `person_access`。审计或数据库步骤失败时注销事务回滚。
- Web 只有收到服务端注销成功响应后，才删除 IndexedDB 中的 capture 元数据、原始 Blob、人员缓存和本地键值。

## Data / Model

- `account.archived_at` 是账户生命周期状态。账户行不物理删除，因为历史文档、上传批次和人工决策仍通过 `account.id` 引用操作者。
- `person` 才是病历归属主体。注销账户只撤销访问，不级联删除患者档案、病历原件、journal 或审计。
- L1 病历及审计继续遵守长期治理锁；“注销账户”不等于“立即物理删除医疗档案”。

## Operation Guide

### 查看或退出

1. 登录后在主导航进入“账户”。
2. 在账户资料卡查看邮箱、显示名称、时区和注册时间。
3. 点击“退出登录”结束当前浏览器会话。若仍有待上传内容，登录页会提示这些内容继续保存在本机。

### 注销账户

1. 在“账户”页进入“注销账户”。
2. 阅读不可恢复、档案保留和本机待上传内容清除提示。
3. 输入当前密码并勾选确认。
4. 点击“永久注销账户”。成功后返回登录页，原账户及其旧令牌不能再使用。

## Verification

- 自动验证：共享契约 18 项测试通过；全仓 `pnpm typecheck`、`pnpm test` 和 Web 生产构建通过。
- 发布验证：迁移后确认 `GET /account` 返回资料；错误密码不能注销；正确密码注销后旧令牌返回 401、`person_access` 清空且审计存在 `access_revoke`。
- 项目所有者在本页经人工审核发布、知识摄取达到 `index_state=ready` 后，负责验证搜索“注销账户后病历是否删除”能命中本页。

## Risks and Fallback

- 正常退出会保留待上传原件。共用或转交设备前，应先完成上传；如无法重新登录，应由设备所有者在浏览器设置中删除本站数据。
- 对象存储审计不可用时，注销会失败并保留账户与授权，避免出现撤权成功但审计缺失。
- 浏览器本地清理若失败，服务端账户仍已注销；登录页会提示用户到浏览器的网站数据设置中手动删除 MediReco 数据。
- 原邮箱可在以后注册一个全新的账户，但不会恢复旧账户的档案访问权。

## Change Log

- 2026-08-26：实现账户中心、当前浏览器退出、密码与二次确认保护的匿名化注销及本机数据清理。
