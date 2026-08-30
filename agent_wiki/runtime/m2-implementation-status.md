---
title: "M2 实现状态与恢复锚点"
kind: runtime
status: active
task: "m2-ai-metadata-and-reconciliation"
updated_on: 2026-08-28
source_commit: "29f2fe84daf4c9b9e2db01ff054ae0fcb672e970"
owners: ["ai-medical-record"]
---

# M2 实现状态与恢复锚点

> M2 现为独立 AI plugin qualification 轨，不阻塞 P0–P4 Core。功能主线恢复入口是 [`specs/p0-p4-core/CLAUDE.md`](../../specs/p0-p4-core/CLAUDE.md)；本页只用于续接 M2 provider/wire/质量基线工作。

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
- archive/ack/facility+encounter normalization 人工层全局排序回放；未知事件继续、旧 encounter 载荷对账、零 AI 调用与二次重建幂等已在隔离环境验证。
- cassette 录制/回放、等长脱敏、提交盒 PII 扫描和独立 `pnpm m2:acceptance` 编排骨架。

## 明确未实现

- A 组当前有 18/42 个候选场景自动化：A1–A8、A9b、A10–A12、A15–A17、A33–A35；B 组按 CHANGES #14 为 15/15。4 个模型盒均为 synthetic，真实 wire cassette 未完成前第一批不计正式验收。逐项缺口见 `specs/m2/ACCEPTANCE-COVERAGE.md`。
- C 组至少 20 份脱敏真实单据、质量回归集和 C1–C9 基线；项目所有者于 2026-08-27 确认延期收集。该项只阻塞 M2/plugin 最终关闭，不阻塞 Core P0–P4。

## 当前下一步

下一实现断点是继续接入 A12b–A14、A18–A32 的跨层验收，优先处理 correction/rebuild 与不依赖并行 UI session 的后端切片。C 组作为独立的延后质量门槛，待项目所有者提供真实脱敏数据后补跑，当前不得用合成数据代替。

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
- 2026-08-27 DeepSeek `deepseek-v4-flash-vision-exp` 已上线；图片/文本使用 Responses API 严格 JSON Schema，PDF 使用 Anthropic document 兼容层并在本地 Zod 再校验。一个真实上传 JPEG Stage 1 job 已到 `done`，工件记录实际模型、1 页、2010 input / 982 output / 1536 cache-read tokens；线上 AI 运行门禁已满足。
- 2026-08-27 A2 核对发现旧 S1 请求把页号 text 放在 image 前，与冻结规格冲突；已升级 prompt v3，改为所有 image blocks 后接唯一全局页号映射 text，并更新 committed cassette。
- 2026-08-27 独立验收审查否决“第一批可验收”结论：4 个盒均为手工 synthetic stub，不能证明真实 wire；已加入 provenance、全库列 A6 扫描、A15 transport 计数、invalid_output 同步重试及并发隔离。20 份真实单据仍可延期，wire cassette 可另用合成图录制。
- 真实作业同时确认了人工兜底：另一份文档的 `event_at` 未符合 RFC3339，作业正确进入 `needs_human/invalid_output`，没有将不合规数据落库。`GET /api/v1/jobs` 对旧错误记录缺少 `category` 的 500 已由契约默认 `null` 修复，线上回归为 200。
- 文档边界实现已通过类型、单元与构建门禁；尚未在现有本机档案上执行破坏逻辑归属的人工冒烟，需用专用测试文档验收移页后预览。
- multipart 已发布，真实 12 MiB 探针通过 create/sign/part PUT/ETag CORS/仅签缺失 part/complete/整文件 SHA-256，探针产生的 L2 数据已清理。
