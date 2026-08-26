---
title: "AI 病历 — 账号注册与首次本人档案"
category: feature
tags: [account, authentication, registration, onboarding]
status: shipped
module: platform
audience: [user, operator, reviewer]
since: 2026-08-26
owners: ["ai-medical-record"]
routes:
  - "/"
  - "/api/v1/auth/register"
  - "/api/v1/auth/login"
sources:
  - "packages/contracts/src/auth.ts"
  - "apps/api/src/routes/auth.ts"
  - "apps/api/src/person-service.ts"
  - "apps/web/src/features/capture/LoginView.tsx"
  - "packages/contracts/test/auth.test.ts"
---

# 账号注册与首次本人档案

## Purpose

允许首次使用者自行创建 MediReco 账号，并直接获得一个可上传病历的本人档案，无需管理员预先运行账号脚本。

## Scope

- 已支持：邮箱和姓名注册、出生日期、出生时性别（可选择暂不填写）、浏览器时区、长密码、自动建本人档案、自动登录、重复邮箱提示和注册限流。
- 不支持：邮箱验证、找回密码、修改密码、MFA、第三方登录和关闭公开注册。

## API / Behavior

- `POST /api/v1/auth/register` 接收 `email`、`password`、`display_name`、`birth_date`、`sex_at_birth` 和 `timezone`。
- 邮箱去除首尾空格并转为小写；密码要求 12–128 位；时区要求有效 IANA 名称；出生日期不能晚于当天。
- 成功响应为 `201 { "access_token": "…" }`。Web 保存令牌、拉取人员列表并进入采集页。
- 同一事务创建账号、关系为 `self` 的本人档案及 `owner` 权限；建档同时写 S3 人员 sidecar、人员索引、person journal 和权限审计。任一存储步骤失败时数据库事务回滚。
- 重复邮箱返回 `409 email_already_registered`；注册按直连 IP 每分钟最多尝试 5 次，超限返回 `429 rate_limited`。
- `POST /api/v1/auth/login` 对邮箱应用相同的去空格和小写规范化，兼容用户按不同大小写输入。

## Data / Model

- 沿用现有 `account`、`person` 和 `person_access` 表，不需要数据库迁移。
- 密码使用现有 Argon2id 参数散列保存；明文密码不落数据库、对象存储或日志。
- 本人档案使用注册姓名、出生日期、出生时性别，`relation_to_owner = self`；未填写出生时性别时保存为 `unknown`。
- 账号时区用于此后根据上传时间计算文档的本地 `capture_date`。

## Operation Guide

1. 打开应用首页，选择“创建账号”。
2. 填写姓名、邮箱和出生日期；出生时性别可保持“暂不填写”。
3. 输入至少 12 位密码并再次确认。
4. 点击“创建并进入档案”。
5. 成功后页面直接进入采集区，当前档案应显示刚填写的姓名。

已注册邮箱应切换到“登录”使用；系统不会覆盖已有账号或密码。

## Verification

- 契约自动测试覆盖邮箱/姓名规范化、弱密码、未来日期、非法时区和登录邮箱规范化。
- 隔离端到端验收覆盖：注册 201、生成一个 `self` 本人档案、令牌可读档案、重新登录 200、重复注册 409。
- 公网验收覆盖：弱密码 400、已有邮箱 409；桌面 1440px 和手机 390px 注册页字段及按钮可见，浏览器控制台无错误。
- 项目所有者在本页经人工审核发布、知识摄取达到 `index_state=ready` 后，负责验证搜索“注册后自动建立本人档案”能命中本页。

## Risks and Fallback

- 目前没有邮箱验证，公开地址上的使用者只要能访问页面即可申请账号；如需邀请制，必须增加服务端开关或邀请码，不能只隐藏前端入口。
- 注册限流为单实例内存固定窗口，多 API 实例之间不共享；面向大规模公网使用前应改为共享限流存储。
- 当前没有找回密码入口。忘记密码时只能由运维通过受控流程重置，不能向用户索取旧密码。
- 浏览器自动报告时区；API 客户端未提供时默认 `Asia/Shanghai`。

## Change Log

- 2026-08-26：上线自助注册、自动创建本人档案和注册后直接登录。
