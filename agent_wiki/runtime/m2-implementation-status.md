---
title: "M2 实现状态与恢复锚点"
kind: runtime
status: active
task: "m2-ai-metadata-and-reconciliation"
updated_on: 2026-08-24
source_commit: "1c8fbba8b04da0336c9b2fae241afd712e55f302"
owners: ["ai-medical-record"]
---

# M2 实现状态与恢复锚点

## 恢复入口

仓库没有标准的 `<app>/.tasks/<task>/CLAUDE.md`。恢复 M2 时按以下顺序读取：

1. [`specs/m2/00-scope.md`](../../specs/m2/00-scope.md)
2. 当前要实现的专题 spec（`02`–`07`）
3. [`specs/m2/99-acceptance.md`](../../specs/m2/99-acceptance.md)
4. [`docs/11-deployment.md`](../../docs/11-deployment.md)
5. 实际代码、测试与 Git diff

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

## 明确未实现

- `facility_normalize` 与 `encounter_suggest` handler；worker 当前把它们终结为 `needs_human/handler_not_implemented`。
- 正常 PDF Stage 1 document-block 路径；当前 PDF 进入 `unsupported`。
- 人工归人告警 ack、facility/encounter 确认及 `_index/decisions` 双写。
- 文档软删除写路径、归人纠正、split/merge/move-page。
- multipart create/sign/complete 与断点续传。
- `document_archive`、`person_check_ack`、`normalization_confirm` 的 rebuild 回放。
- M2 cassette、回归集基线、`infra/run-m2.sh` 和根级 `m2:acceptance` 脚本。

## 当前下一步

先实现 `facility_normalize` 和 `encounter_suggest` 的完整闭环：

1. 判断缓存与 handler。
2. 确定性执行和批量回填。
3. 人工确认/拒绝端点。
4. `_index/decisions` 双写。
5. 对应单测和验收断言。

随后按 `06-corrections → 07-replay → 99-acceptance` 收口。

## 恢复时必须重新核实

- `git status --short` 与 `git diff --name-only`，避免覆盖并行工作。
- 本页 `source_commit` 是否仍为当前 HEAD；若不是，直接复核相关实现。
- worker 中未实现分支、PDF fallback 和根 `package.json` 是否已经变化。
- `specs/m2/CHANGES.md` 是否新增裁决。

## 硬约束

- 归人从不静默默认。
- M2 只做建议，禁止自动创建 encounter。
- 模型输出属于 L2；人工确认属于 L1，必须可回放。
- A/B 工程验收必须全绿；C 组只记录质量基线，不设置拍脑袋阈值。
