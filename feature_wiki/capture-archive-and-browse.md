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
  - "/api/v1/people"
  - "/api/v1/uploads/presign"
  - "/api/v1/uploads/multipart/create"
  - "/api/v1/uploads/multipart/sign"
  - "/api/v1/uploads/multipart/complete"
  - "/api/v1/documents"
  - "/api/v1/captures/discard"
sources:
  - "apps/web/src/App.tsx"
  - "apps/web/src/features/capture/CaptureView.tsx"
  - "apps/web/src/features/capture/CreatePersonDialog.tsx"
  - "apps/web/src/features/capture/QueuePanel.tsx"
  - "apps/web/src/features/browse/BrowseView.tsx"
  - "apps/web/src/offline/queue.ts"
  - "apps/web/src/offline/db.ts"
  - "apps/web/src/offline/multipart.ts"
  - "apps/api/src/routes/documents.ts"
  - "apps/api/src/routes/multipart.ts"
  - "packages/contracts/src/multipart.ts"
  - "apps/api/src/routes/browse.ts"
  - "specs/m1/RESULTS.md"
---

# 采集、离线队列与档案浏览

## Purpose

让用户在医院弱网或离线环境中先安全保存照片/PDF，联网后自动完成上传和登记，再按家庭成员与日期浏览档案。

## Scope

- 已支持：登录、创建和选择家庭成员、相机拍摄、连续多页拍摄、相册多选、PDF、IndexedDB 队列、前台重试、放弃确认、按人浏览、缩略图和预览。
- 源码已实现、待测试部署发布与 owner 验收：`>8 MiB` 文件的 multipart 分片上传与刷新续传。
- 不支持：关闭应用后的后台上传、超过 50 MiB 的文件。文档详情、Core 关键词检索和趋势已实现，见 [P0–P4 Core 功能页](./core-context-data-trends-and-exports.md)。

## API / Behavior

归档采用三步链路：

1. `POST /api/v1/uploads/presign` 建立上传批次；`≤8 MiB` 返回单 PUT URL，`>8 MiB` 只返回 multipart 模式，不下发可绕过分片的单 PUT URL。
2. 小文件由浏览器直接 PUT；大文件依次调用 `/uploads/multipart/create`、`/sign`、对象存储 PUT part 和 `/complete`。
3. `POST /api/v1/documents` 以 `client_document_id` 幂等登记文档。

关键行为：

- 人员选择器可调用 `POST /api/v1/people` 创建配偶、父母、子女、兄弟姐妹或其他家庭成员；成功后新成员立即成为当前档案。
- 每页读入后立即物化到 IndexedDB；多页草稿不依赖当前标签页内存。
- 未选人时允许先拍，但队列停在“待归人”，不会上传。
- 上传开始后禁止改归属人，因为最终对象 key 已由 person 决定。
- 401 会暂停而不清空队列；重新登录后恢复。
- 大文件固定使用 8 MiB part（末片可小）；每个成功 part 的 `{part_number, etag}` 立即写入 IndexedDB，刷新后只签名和上传缺失 part。
- multipart complete 后由 API 回读合并对象并重算原始字节 SHA-256；校验通过才允许文档登记。UploadId 被生命周期清理时只重建该文件的 multipart，不重传同批已完成文件。
- 终止失败保留本地原件，用户可以重试或经二次确认放弃。
- 浏览页按 `capture_date` 倒序分组，每页 20 条游标分页；缩略图通过受权 API 302 到短期预签名 URL。
- 点击图片档案卡片会打开全屏大图预览；多页文档可使用左右按钮或键盘方向键翻页，`Esc`、右上角关闭按钮或点击遮罩可退出。
- PDF 可归档和浏览占位，但当前没有图片缩略图。

## Data / Model

- 浏览器只缓存人员选择器所需的 `id`、`slug`、`display_name`、`relation_to_owner`，不缓存生日、过敏史等额外医疗 PII。
- `client_document_id` 是弱网重试的幂等键。
- `upload_file.id` 连接预签名批次与 multipart；S3 的 opaque UploadId 和已完成 ETag 仅作为可恢复上传状态，不属于病历 L1。
- 原始拍摄时间优先取 EXIF `DateTimeOriginal`；EXIF orientation 落 L1 sidecar，派生图按方向旋正并移除 EXIF/GPS。
- 原件、`capture.json` 和 page sidecar 属于 L1；缩略图、预览图属于可重生 L2。

## Operation Guide

1. 登录后选择归属人；若成员尚未建档，点击“添加成员”，填写姓名、关系和出生信息后创建。
2. 创建成功会自动切换到新成员；确认当前档案后点击“拍照”，或选择“相册 / PDF”。
3. 多页拍摄完成后点击“完成这份”。
4. 保持应用打开；队列显示“全部已上传”后再离开。
5. 切换到“档案”，选择人员并按日期浏览已上传文档。
6. 点击图片卡片查看大图；多页报告使用左右按钮翻页，查看完毕后点击右上角关闭。

未选择人员时，可以先拍摄，再在队列中补选归属人。若浏览器未授予持久存储，按页面提示添加到主屏幕并尽快联网。
大文件不需要额外操作；刷新页面后重新登录或恢复网络，队列会从已保存的分片继续。

## Verification

- 自动证据：`specs/m1/RESULTS.md` 的 A 组 88/88 与 B 组全绿。
- 核查断网连拍、刷新恢复、恢复网络后队列清空、跨登录续跑、归属人和日期分组。
- 公网浏览器验证：桌面 1440px 与手机 390px 均可点击真实已上传图片打开全屏预览，派生图请求返回 `302 → 200`，图片完成解码，Esc 可关闭且控制台无错误。
- 家庭成员补录验证：Chromium 桌面 1440×900 与手机 390×844 均通过创建、自动切换、顶栏同步和精简人员缓存检查，控制台无错误；完整 M1 A1b 与项目所有者预览仍待执行。
- multipart 自动证据：contracts 26/26、API 34/34、Web 3/3 目标测试通过；覆盖强制大文件模式、8 MiB 规划、连续 ETag 清单、缺失 part 识别和 complete 崩溃恢复分类。
- multipart owner 验收：发布当前工作树后上传至少 12 MiB 测试文件，在首个 part 完成后刷新，确认只上传剩余 part、最终登记成功且浏览原件摘要一致。当前尚未执行，负责人为项目所有者。
- 人工真机项仍需项目所有者在 iOS Safari、Android Chrome 和真实三页单据上执行。
- 发布并完成知识索引后，由项目所有者验证搜索“保持应用打开直到上传完成”能命中本页。

## Risks and Fallback

- iOS 不支持本项目所需的可靠 Background Sync；页面只承诺应用打开时推进队列。
- 浏览器可能清理非持久化存储；UI 会显示风险提示。
- 单文件上限仍为 50 MiB；对象存储会在 1 天后清理未完成 multipart，客户端遇到失效 UploadId 会为该文件重新建分片上传。
- 本地队列不是长期备份，最终可靠归档以服务端登记和 L1 对象落桶为准。

## Change Log

- 2026-08-18：M1 自动验收 A 组 88/88、B 组全绿；真机 C1–C3 待所有者验证。
- 2026-08-24：建立稳定功能知识页。
- 2026-08-26：修复档案卡片无效 Hash 跳转，增加全屏大图查看和多页翻页控件。
- 2026-08-26：补齐家庭成员创建入口；创建后立即更新精简人员缓存并切换当前档案。
- 2026-08-26：实现 `>8 MiB` 三段式 multipart、IndexedDB ETag 续传和服务端整文件 SHA-256 回流校验；等待测试部署发布与 owner 真实 12 MiB 验收。
- 2026-08-28：文档详情、Core 关键词检索与趋势进入 P0–P4 工作树，从本页的“不支持”列表移除。
