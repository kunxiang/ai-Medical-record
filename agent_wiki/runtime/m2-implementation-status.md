---
title: "M2 实现状态与恢复锚点"
kind: runtime
status: active
task: "m2-ai-metadata-and-reconciliation"
updated_on: 2026-08-26
source_commit: "338a4e729f5ae3c22f6505e4caa54eca99c31b66"
owners: ["ai-medical-record"]
---

# M2 实现状态与恢复锚点

## 恢复入口

仓库没有标准的 `<app>/.tasks/<task>/CLAUDE.md`。M2 已在 2026-08-26 进入开发中，原子任务清单为 [`specs/m2/tasks.md`](../../specs/m2/tasks.md)。恢复时按以下顺序读取：

1. [`specs/m2/00-scope.md`](../../specs/m2/00-scope.md)
2. 当前要实现的专题 spec（`02`–`07`）
3. [`specs/m2/99-acceptance.md`](../../specs/m2/99-acceptance.md)
4. [`docs/11-deployment.md`](../../docs/11-deployment.md)
5. 实际代码、测试与 Git diff

编码路由为 `fullstack`，依赖顺序固定为 backend → frontend。

来源选择和哈希记录在 [`docs/context-manifest.yaml`](../../docs/context-manifest.yaml)。

## 已实现并有代码证据

- `packages/ai` 骨架、模型注册、版本化 prompt、Stage 1 调用及分批合并。
- `ai` 图像派生物和 extraction key。
- M2 contracts、迁移 `0003_m2_ai_metadata.sql`、`ai_job` 与 `normalization_decision` 表。
- PostgreSQL job claim、僵尸回收、退避重试、终态和显式 rerun。
- 文档登记与 Stage 1 job 同事务投递。
- Stage 1 图像路径、工件写入、DB 派生字段更新和确定性归人比对。
- `GET /api/v1/documents/:id/ai`、`GET /api/v1/jobs`、`POST /api/v1/documents/:id/ai/rerun`。
- 文档列表已下发 M2 元数据、归人对账状态和 ack 时间字段。
- facility 指纹缓存、AI 提议、确定性批量回填、人工确认/拒绝与 `_index/decisions` 双写。
- person 级 encounter 候选预筛、AI 二文档建议、人工确认建组及弱判据 UI。
- 归人告警确认、归人纠正 correction/manifest/journal 追加，以及文档归档/恢复 journal+audit 双写。
- split/merge/move-page 边界接口、page_move correction、派生物失效与 correction 重建回放。
- 正常 PDF Stage 1 document-block、32 MiB/600 页门禁、PDF 内部页序校验与 S1 prompt v2。
- `>8 MiB` 三段式 multipart、固定 8 MiB part、服务端整文件 SHA-256 回流校验，以及 IndexedDB UploadId/ETag 断点恢复。

## 明确未实现

- `document_archive`、`person_check_ack`、`normalization_confirm` 的 rebuild 回放。
- M2 cassette、回归集基线、`infra/run-m2.sh` 和根级 `m2:acceptance` 脚本。

## 当前下一步

下一实现断点是 `07-replay` 其余人工层事件；随后推进 `99-acceptance`。

## 恢复时必须重新核实

- `git status --short` 与 `git diff --name-only`，避免覆盖并行工作。
- 本页 `source_commit` 是否仍为当前 HEAD；若不是，直接复核相关实现。
- PDF fallback、文档边界接口和根 `package.json` 是否已经变化。
- `specs/m2/CHANGES.md` 是否新增裁决。

## 硬约束

- 归人从不静默默认。
- M2 只做建议，禁止自动创建 encounter。
- 模型输出属于 L2；人工确认属于 L1，必须可回放。
- A/B 工程验收必须全绿；C 组只记录质量基线，不设置拍脑袋阈值。

## 当前门禁

- M0/M1 已于 2026-08-26 经项目所有者确认验收并关闭；剩余人工项没有新增独立执行证据，已在各自 `RESULTS.md` 如实记录。
- 测试部署的 Stage 1 仍缺有效 `ANTHROPIC_API_KEY`；不阻塞离线实现，但真实模型 job 到 `done` 前不得宣称线上 AI 可用。
- 文档边界实现已通过类型、单元与构建门禁；尚未在现有本机档案上执行破坏逻辑归属的人工冒烟，需用专用测试文档验收移页后预览。
- multipart 源码和目标测试已通过；当前测试部署尚未发布本工作树，真实 12 MiB 上传、刷新后只补缺失 part 及整文件登记仍需项目所有者在发布后验收。
