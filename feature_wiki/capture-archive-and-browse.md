---
title: "AI 病历 — 采集、离线队列与档案浏览"
category: feature
tags: [capture, offline, archive, browse, pwa]
status: shipped
module: web
audience: [user, operator, reviewer]
since: 2026-08-18
owners: ["ai-medical-record"]
routes:
  - "/"
  - "/api/v1/auth/login"
  - "/api/v1/uploads/presign"
  - "/api/v1/documents"
  - "/api/v1/captures/discard"
sources:
  - "apps/web/src/App.tsx"
  - "apps/web/src/features/capture/CaptureView.tsx"
  - "apps/web/src/features/capture/QueuePanel.tsx"
  - "apps/web/src/features/browse/BrowseView.tsx"
  - "apps/web/src/offline/queue.ts"
  - "apps/api/src/routes/documents.ts"
  - "apps/api/src/routes/browse.ts"
  - "specs/m1/RESULTS.md"
---

# 采集、离线队列与档案浏览

## Purpose

让用户在医院弱网或离线环境中先安全保存照片/PDF，联网后自动完成上传和登记，再按家庭成员与日期浏览档案。

## Scope

- 已支持：登录、选择归属人、相机拍摄、连续多页拍摄、相册多选、PDF、IndexedDB 队列、前台重试、放弃确认、按人浏览、缩略图和预览。
- 不支持：关闭应用后的后台上传、超过 50 MiB 的文件、multipart 断点续传、文档详情 UI、全文检索和趋势。

## API / Behavior

归档采用三步链路：

1. `POST /api/v1/uploads/presign` 获取原件直传 URL。
2. 浏览器直接 PUT 到对象存储，原件不经过 API。
3. `POST /api/v1/documents` 以 `client_document_id` 幂等登记文档。

关键行为：

- 每页读入后立即物化到 IndexedDB；多页草稿不依赖当前标签页内存。
- 未选人时允许先拍，但队列停在“待归人”，不会上传。
- 上传开始后禁止改归属人，因为最终对象 key 已由 person 决定。
- 401 会暂停而不清空队列；重新登录后恢复。
- 终止失败保留本地原件，用户可以重试或经二次确认放弃。
- 浏览页按 `capture_date` 倒序分组，每页 20 条游标分页；缩略图通过受权 API 302 到短期预签名 URL。
- PDF 可归档和浏览占位，但当前没有图片缩略图。

## Data / Model

- 浏览器只缓存人员选择器所需的 `id`、`slug`、`display_name`、`relation_to_owner`，不缓存生日、过敏史等额外医疗 PII。
- `client_document_id` 是弱网重试的幂等键。
- 原始拍摄时间优先取 EXIF `DateTimeOriginal`；EXIF orientation 落 L1 sidecar，派生图按方向旋正并移除 EXIF/GPS。
- 原件、`capture.json` 和 page sidecar 属于 L1；缩略图、预览图属于可重生 L2。

## Operation Guide

1. 登录后选择归属人。
2. 点击“拍照”连续添加页面，或选择“相册 / PDF”。
3. 多页拍摄完成后点击“完成这份”。
4. 保持应用打开；队列显示“全部已上传”后再离开。
5. 切换到“档案”，选择人员并按日期浏览已上传文档。

未选择人员时，可以先拍摄，再在队列中补选归属人。若浏览器未授予持久存储，按页面提示添加到主屏幕并尽快联网。

## Verification

- 自动证据：`specs/m1/RESULTS.md` 的 A 组 88/88 与 B 组全绿。
- 核查断网连拍、刷新恢复、恢复网络后队列清空、跨登录续跑、归属人和日期分组。
- 人工真机项仍需项目所有者在 iOS Safari、Android Chrome 和真实三页单据上执行。
- 发布并完成知识索引后，由项目所有者验证搜索“保持应用打开直到上传完成”能命中本页。

## Risks and Fallback

- iOS 不支持本项目所需的可靠 Background Sync；页面只承诺应用打开时推进队列。
- 浏览器可能清理非持久化存储；UI 会显示风险提示。
- 单文件上限 50 MiB；大文件分片续传尚未实现。
- 本地队列不是长期备份，最终可靠归档以服务端登记和 L1 对象落桶为准。

## Change Log

- 2026-08-18：M1 自动验收 A 组 88/88、B 组全绿；真机 C1–C3 待所有者验证。
- 2026-08-24：建立稳定功能知识页。
