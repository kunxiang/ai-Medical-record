# Implementation Tasks: P0-P4 非 AI 核心主线

> Generated from reviewed specs on 2026-08-28  
> Review status: PASS (`review-002.md`)  
> REQUIRED_SKILL_ROUTE: `fullstack`（本仓库前后端均为 TypeScript；按 contracts/schema/service/routes → Web 推进）  
> Execution strategy: `codex_local`（migration、权限、journal/rebuild 与 shared contracts 是单一高风险关键路径）  
> LSP: 当前运行面未暴露 MCP-LSP；fallback 为 `rg`、定点源码阅读、TypeScript typecheck/test  
> Repo instructions: 未发现 `AGENTS.md` 或 `.claude/coordination/ACTIVE_EDITS.md`，无需登记协作锁

## 全局约束

- AI 只辅助；`PROCESSING_MODE=off` 是默认且必须完成全部 core 路径。
- 人工 L1 写入必须同批交付 strict contract、journal registry、rebuild、幂等恢复测试。
- 无权限与不存在统一 404；person/source 归属在事务内校验。
- 每个里程碑先 backend/contracts，验证后再 Web；不跨里程碑预写。
- Wiki：`agent_wiki/architecture-data-and-security.md`、`agent_wiki/runtime/m2-implementation-status.md`、`feature_wiki/capture-archive-and-browse.md`、`feature_wiki/ai-metadata-and-jobs.md`。

## Milestone 0: Core-0 — AI 运行时与发布门禁解耦

- [x] **[M] Contracts/config**：增加 processing mode、capability、plugin/job/suggestion envelopes
  - 文件：`packages/contracts/src/processing.ts`, `packages/contracts/src/index.ts`, `apps/api/src/env.ts`
  - Spec：`01_design_spec.md` §3；`02_api_contracts.md` §2；`03_database.md` §9
  - Wiki 引用：architecture-data-and-security L1/L2 边界
  - verify (auto)：`pnpm --filter @amr/contracts typecheck && pnpm --filter @amr/contracts test`
  - verify (manual)：—

- [x] **[L] Processing persistence/queue**：新增 processing_plugin/job/suggestion 与 operation_ledger migration、Drizzle schema、target plugin/version claim/dedup/backfill
  - 文件：`apps/api/src/db/schema.ts`, `apps/api/drizzle/*.sql`, `apps/api/src/processing/**`
  - Spec：`03_database.md` §2–3, §9
  - Wiki 引用：runtime/m2-implementation-status（旧 ai_job 兼容）
  - verify (auto)：`pnpm --filter @amr/api typecheck && pnpm --filter @amr/api test`
  - verify (manual)：检查 migration expand-only，旧表未有损改写

- [x] **[L] Process split**：API 移除 worker/provider 静态调用；独立 plugin worker entrypoint；旧 ai_job 停止新投递并可原位 drain
  - 文件：`apps/api/src/server.ts`, `apps/api/src/main.ts`, `apps/api/src/plugin-main.ts`, `apps/api/src/jobs/**`, `apps/api/src/routes/{ai,normalization,documents,corrections}.ts`, `apps/api/package.json`, `infra/docker-compose*.yml`
  - Spec：`01_design_spec.md` §3.2–3.3
  - Wiki 引用：feature_wiki/ai-metadata-and-jobs（保持历史行为可见）
  - verify (auto)：`pnpm --filter @amr/api typecheck && pnpm --filter @amr/api test && pnpm ci:deps`
  - verify (manual)：API 进程模块图不加载 provider SDK；plugin worker 可独立不部署

- [x] **[M] Capability API**：实现 `/api/v1/capabilities`、心跳过期和 core-only 默认
  - 文件：`apps/api/src/routes/capabilities.ts`, `apps/api/src/server.ts`, `apps/api/test/capabilities.test.ts`
  - Spec：`02_api_contracts.md` §2；`04_acceptance.md` C0-1..8
  - Wiki 引用：none
  - verify (auto)：`pnpm --filter @amr/api test -- capabilities.test.ts`
  - verify (manual)：—

- [x] **[M] Web capability fail-closed**：登录后读取能力；失败/off 时隐藏新 AI 失败态但保留历史建议入口
  - 文件：`apps/web/src/api/client.ts`, `apps/web/src/App.tsx`, `apps/web/src/features/browse/**`, `apps/web/src/features/account/**`
  - Spec：`01_design_spec.md` §3.4；`05_ux_states.md` §2
  - Wiki 引用：capture-archive-and-browse、ai-metadata-and-jobs
  - verify (auto)：`pnpm --filter @amr/web typecheck && pnpm --filter @amr/web test`
  - verify (manual)：capability 请求失败仍可采集、浏览、账户操作

- [x] **[M] Core acceptance entry**：新增不读取 AI fixture/cassette 的 `pnpm core:acceptance`，校验 off/no-key/no-provider/no-new-job
  - 文件：`package.json`, `infra/run-core.sh`, `tools/src/core-acceptance.ts`, `tools/package.json`
  - Spec：`04_acceptance.md` §0–1
  - Wiki 引用：runtime/m2-implementation-status（M2 只作为 plugin qualification）
  - verify (auto)：`pnpm core:acceptance`
  - verify (manual)：—

## Milestone 1: P0 — 人工归档、三层组织、检索与 bundle

- [x] **[L] P0 schema/migration**：document_manual_metadata、field provenance、encounter revision、search_entry 与日期/游标索引
  - 文件：`apps/api/src/db/schema.ts`, `apps/api/drizzle/*.sql`
  - Spec：`03_database.md` §2–3, §7
  - Wiki 引用：architecture-data-and-security
  - verify (auto)：`pnpm --filter @amr/api typecheck`
  - verify (manual)：migration 从 0000 全量重放；既有 AI 列保留

- [x] **[M] P0 contracts**：effective metadata、五种 date_field、encounter CRUD/link、generic search、legacy inbox schemas
  - 文件：`packages/contracts/src/metadata.ts`, `packages/contracts/src/search.ts`, `packages/contracts/src/encounter.ts`, `packages/contracts/src/index.ts`
  - Spec：`02_api_contracts.md` §3–4
  - Wiki 引用：capture-archive-and-browse
  - verify (auto)：`pnpm --filter @amr/contracts typecheck && pnpm --filter @amr/contracts test`
  - verify (manual)：—

- [x] **[L] Operation replay/journal**：L1 event 保存 request hash/safe response/完整 snapshot；rebuild 恢复 ledger、facility/page 引用
  - 文件：`packages/contracts/src/journal.ts`, `apps/api/src/journal.ts`, `tools/src/human-replay.ts`, `tools/src/rebuild-index.ts`, `tools/src/verify-rebuild.ts`
  - Spec：`03_database.md` §10
  - Wiki 引用：architecture-data-and-security
  - verify (auto)：`pnpm --filter @amr/contracts test && pnpm --filter @amr/tools test`
  - verify (manual)：—

- [x] **[L] Metadata/list/encounter services**：人工 metadata Merge Patch、逐字段 effective value/source、五种日期、稳定 cursor、encounter CRUD/link
  - 文件：`apps/api/src/services/metadata.ts`, `apps/api/src/services/encounters.ts`, `apps/api/src/routes/documents.ts`, `apps/api/src/routes/encounters.ts`, `apps/api/test/p0-*.test.ts`
  - Spec：`02_api_contracts.md` §3–4；`04_acceptance.md` P0-1..4
  - Wiki 引用：capture-archive-and-browse
  - verify (auto)：`pnpm --filter @amr/api test -- p0`
  - verify (manual)：—

- [x] **[L] Legacy suggestion/search**：历史建议实体化、逐字段/批量接受、可撤销；确定性 search projection/backfill/generic result
  - 文件：`apps/api/src/services/{suggestions,search}.ts`, `apps/api/src/routes/{suggestions,search}.ts`, `tools/src/rebuild-index.ts`, `apps/api/test/p0-*.test.ts`
  - Spec：`01_design_spec.md` §4, §5.1；`02_api_contracts.md` §3–4
  - Wiki 引用：ai-metadata-and-jobs
  - verify (auto)：`pnpm --filter @amr/api test -- p0 && pnpm --filter @amr/tools test`
  - verify (manual)：off 时历史建议仍可见，未确认建议不进 core search

- [x] **[M] P0 bundle**：单人 L1 bundle 过滤、manifest/decision/meta 和空库恢复
  - 文件：`apps/api/src/exports/person-bundle.ts`, `apps/api/src/routes/exports.ts`, `tools/src/rebuild-index.ts`, `tools/src/verify-rebuild.ts`
  - Spec：`04_acceptance.md` P0-10
  - Wiki 引用：architecture-data-and-security
  - verify (auto)：`pnpm core:acceptance -- --milestone=p0`
  - verify (manual)：抽查 ZIP 不含他人路径/决策

- [ ] **[L] P0 Web**：四项导航+采集 FAB、文档筛选/分组/搜索、图片大图/PDF fallback、人工元数据、legacy inbox
  - 文件：`apps/web/src/App.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/features/browse/**`, `apps/web/src/features/metadata/**`, `apps/web/src/styles.css`
  - Spec：`01_design_spec.md` §6；`05_ux_states.md` §1, §4
  - Wiki 引用：capture-archive-and-browse
  - verify (auto)：`pnpm --filter @amr/web typecheck && pnpm --filter @amr/web test`
  - verify (manual)：移动/桌面：找旧文档、PDF fallback、逐字段冲突合并
  - status：实现与真实浏览器 17/17 已通过；保留未勾选，等待 owner 预览和 P0-11 `<60 秒` 人工 gate。

## Milestone 2: P1 — 离线情境与安全媒体

- [x] **[M] Context contracts/templates**：版本化模板、条件题、timeline_kind/event_time_source、strict session/answer/upload schemas
  - 文件：`packages/contracts/src/context.ts`, `packages/contracts/src/index.ts`, `packages/medical/src/context-templates/**`
  - Spec：`02_api_contracts.md` §5；`03_database.md` §4
  - Wiki 引用：none
  - verify (auto)：`pnpm --filter @amr/contracts test && pnpm --filter @amr/medical test`
  - verify (manual)：—

- [x] **[L] Context persistence/journal**：context_session/answer/upload migration、revision、operation replay、strict journal/rebuild
  - 文件：`apps/api/src/db/schema.ts`, `apps/api/drizzle/*.sql`, `packages/contracts/src/journal.ts`, `tools/src/{human-replay,rebuild-index,verify-rebuild}.ts`
  - Spec：`03_database.md` §4, §10
  - Wiki 引用：architecture-data-and-security
  - verify (auto)：`pnpm --filter @amr/api typecheck && pnpm --filter @amr/tools test`
  - verify (manual)：—

- [x] **[L] Context/media API**：template/session/create-bind/answer/complete/pending 与 prepare-presign-finalize 完整性/归属
  - 文件：`apps/api/src/routes/context.ts`, `apps/api/src/services/context.ts`, `apps/api/src/services/context-upload.ts`, `apps/api/test/context-*.test.ts`
  - Spec：`02_api_contracts.md` §5；`04_acceptance.md` P1-1..9
  - Wiki 引用：capture-archive-and-browse 上传完整性模式
  - verify (auto)：`pnpm --filter @amr/api test -- context`
  - verify (manual)：—

- [x] **[L] IndexedDB v2/offline sync**：模板/session/answer/media 草稿 stores，三种恢复态，operation/revision 冲突保留
  - 文件：`apps/web/src/offline/db.ts`, `apps/web/src/offline/context.ts`, `apps/web/src/offline/queue.ts`, `apps/web/src/offline/*.test.ts`
  - Spec：`01_design_spec.md` §5.2–5.3；`05_ux_states.md` §3
  - Wiki 引用：capture-archive-and-browse
  - verify (auto)：`pnpm --filter @amr/web test && pnpm --filter @amr/web typecheck`
  - verify (manual)：浏览器升级/刷新/离线恢复无 IDB closing error

- [x] **[L] Context Web**：采集后可跳过 CTA、条件题、文字替代、pending 补录、媒体状态、standalone anytime
  - 文件：`apps/web/src/features/context/**`, `apps/web/src/features/capture/**`, `apps/web/src/features/browse/**`, `apps/web/src/api/client.ts`
  - Spec：`05_ux_states.md` §3；`04_acceptance.md` P1-10
  - Wiki 引用：capture-archive-and-browse
  - verify (auto)：`pnpm --filter @amr/web typecheck && pnpm --filter @amr/web test`
  - verify (manual)：拍摄+5题 <90 秒；麦克风拒绝可改文字

- [ ] **[M] P1 acceptance**：离线绑定、standalone、媒体篡改、条件题、重建和无 ASR
  - 文件：`tools/src/core-acceptance.ts`, `apps/api/test/context-*.test.ts`, `apps/web/src/**/*.test.tsx`
  - Spec：`04_acceptance.md` §3
  - Wiki 引用：none
  - verify (auto)：`pnpm core:acceptance -- --milestone=p1`
  - verify (manual)：现场耗时 gate
  - status：`PROCESSING_MODE=off` 总验收已覆盖八类回答、媒体完整性，以及 context→Observation/context→Medication 显式 promote 和重建；保留未勾选，等待麦克风拒绝实机检查与 P1-10 `<90 秒` 现场 gate。

## Milestone 3: P2 — 人工 observation 与确定性医学层

- [x] **[L] Medical package**：新建版本化 concept catalog、值/comparator、UCUM、单位换算、自洽/派生纯函数
  - 文件：`packages/medical/**`, `pnpm-workspace.yaml`, `tsconfig.base.json`
  - Spec：`01_design_spec.md` §5.4；`03_database.md` §5
  - Wiki 引用：architecture-data-and-security（确定性派生）
  - verify (auto)：`pnpm --filter @amr/medical typecheck && pnpm --filter @amr/medical test`
  - verify (manual)：—

- [x] **[L] Observation schema/contracts**：完整 observation、person alias、稳定 origin page identity、series/derivation fields 与 migration/index
  - 文件：`packages/contracts/src/observation.ts`, `apps/api/src/db/schema.ts`, `apps/api/drizzle/*.sql`
  - Spec：`02_api_contracts.md` §6；`03_database.md` §5
  - Wiki 引用：architecture-data-and-security
  - verify (auto)：`pnpm --filter @amr/contracts test && pnpm --filter @amr/api typecheck`
  - verify (manual)：migration 能表达重复 SHA 与多页对象

- [x] **[L] Observation/journal service**：100 行原子 batch、deterministic parse、correction/archive、origin projection、derived dependency replay
  - 文件：`apps/api/src/services/observations.ts`, `apps/api/src/routes/observations.ts`, `packages/contracts/src/journal.ts`, `tools/src/{human-replay,rebuild-index}.ts`
  - Spec：`02_api_contracts.md` §6；`03_database.md` §10
  - Wiki 引用：architecture-data-and-security
  - verify (auto)：`pnpm --filter @amr/api test -- observation && pnpm --filter @amr/tools test`
  - verify (manual)：—

- [x] **[L] Mapping inbox/suggestions**：catalog search、person alias、resolve 原子更新、observation suggestion 接受并复制 provenance
  - 文件：`apps/api/src/services/observation-mapping.ts`, `apps/api/src/routes/medical.ts`, `apps/api/src/routes/suggestions.ts`, `apps/api/test/observation-*.test.ts`
  - Spec：`02_api_contracts.md` §6；`04_acceptance.md` P2-5..8
  - Wiki 引用：ai-metadata-and-jobs
  - verify (auto)：`pnpm --filter @amr/api test -- observation`
  - verify (manual)：插件 off 时从未映射行到可建趋势全程可用

- [ ] **[L] Observation Web workbench**：原件/表格、TSV/CSV 粘贴、报告级继承、复制、键盘、草稿、mapping inbox、冲突合并
  - 文件：`apps/web/src/features/data/**`, `apps/web/src/offline/observations.ts`, `apps/web/src/api/client.ts`, `apps/web/src/App.tsx`
  - Spec：`01_design_spec.md` §6；`05_ux_states.md` §4
  - Wiki 引用：capture-archive-and-browse
  - verify (auto)：`pnpm --filter @amr/web typecheck && pnpm --filter @amr/web test`
  - verify (manual)：10 行桌面 ≤3 分钟、移动 ≤5 分钟
  - status：实现、Web 12/12 与真实 Chromium P2-W1..4 已通过；保留未勾选，等待 owner 桌面/手机预览和 P2-10 现场耗时 gate。

- [ ] **[M] P2 acceptance**：原值/时间/单位/series/source/rebuild/AI isolation
  - 文件：`tools/src/core-acceptance.ts`, `apps/api/test/observation-*.test.ts`, `packages/medical/test/**`
  - Spec：`04_acceptance.md` §4
  - Wiki 引用：none
  - verify (auto)：`pnpm core:acceptance -- --milestone=p2`
  - verify (manual)：人工录入耗时 gate（20 份真实单据非前置）
  - status：`PROCESSING_MODE=off` 后端 72/72、浏览器 30/30；6 条 L1、1 条 derived、1 条 alias 与 34 个 operation 两轮删库重建逐字段等价。保留未勾选，仅等待 P2-10 人工耗时。

## Milestone 4: P3 — 监控组与趋势

- [x] **[M] Metric group contracts/schema/journal**：完整 series selector、“三高+”preset copy、revision/archive/rebuild
  - 文件：`packages/contracts/src/trends.ts`, `apps/api/src/db/schema.ts`, `apps/api/drizzle/*.sql`, `packages/contracts/src/journal.ts`, `tools/src/rebuild-index.ts`
  - Spec：`02_api_contracts.md` §7；`03_database.md` §6
  - Wiki 引用：architecture-data-and-security
  - verify (auto)：`pnpm --filter @amr/contracts test && pnpm --filter @amr/api typecheck && pnpm --filter @amr/tools test`
  - verify (manual)：—

- [x] **[L] Trend service/API**：事实过滤、series 边界、ref、RCV、context overlay、source link、0/1 点与固定下采样
  - 文件：`apps/api/src/services/trends.ts`, `apps/api/src/routes/trends.ts`, `apps/api/test/trends-*.test.ts`, `packages/medical/src/rcv.ts`
  - Spec：`02_api_contracts.md` §7；`04_acceptance.md` §5
  - Wiki 引用：architecture-data-and-security
  - verify (auto)：`pnpm --filter @amr/api test -- trend && pnpm --filter @amr/medical test`
  - verify (manual)：—

- [x] **[L] Trends Web**：四项导航中的数据/趋势页、监控组、0/1/大数据/不可比状态、来源回链
  - 文件：`apps/web/src/features/trends/**`, `apps/web/src/features/data/**`, `apps/web/src/App.tsx`, `apps/web/src/api/client.ts`
  - Spec：`05_ux_states.md` §1, §5
  - Wiki 引用：none
  - verify (auto)：`pnpm --filter @amr/web typecheck && pnpm --filter @amr/web test`
  - verify (manual)：移动/桌面趋势、无 bbox/缺原件回链

- [x] **[M] P3 acceptance**：trend/filter/series/ref/RCV/source/downsample/rebuild/AI clear
  - 文件：`tools/src/core-acceptance.ts`, `apps/api/test/trends-*.test.ts`
  - Spec：`04_acceptance.md` §5
  - Wiki 引用：none
  - verify (auto)：`pnpm core:acceptance -- --milestone=p3`
  - verify (manual)：—

## Milestone 5: P4 — 用药/事件、确定性导出与分享

- [x] **[L] P4 facts/schema/contracts**：medication、timeline_event、export_job/share migration、canonical time、revision/index
  - 文件：`packages/contracts/src/{medication,exports}.ts`, `apps/api/src/db/schema.ts`, `apps/api/drizzle/*.sql`
  - Spec：`02_api_contracts.md` §8；`03_database.md` §7–8
  - Wiki 引用：architecture-data-and-security
  - verify (auto)：`pnpm --filter @amr/contracts test && pnpm --filter @amr/api typecheck`
  - verify (manual)：—

- [x] **[L] Medication/timeline API+journal**：CRUD、稳定来源、canonical/undated、context promote、search projection、rebuild
  - 文件：`apps/api/src/services/{medications,timeline}.ts`, `apps/api/src/routes/{medications,timeline}.ts`, `packages/contracts/src/journal.ts`, `tools/src/rebuild-index.ts`
  - Spec：`01_design_spec.md` §5.5；`04_acceptance.md` P4-1..2
  - Wiki 引用：architecture-data-and-security
  - verify (auto)：`pnpm --filter @amr/api test -- medication && pnpm --filter @amr/tools test`
  - verify (manual)：—

- [x] **[L] Deterministic renderer/export worker**：preview、canonical input、固定字体/renderer/content hash、claim/lease/retry/stale、object regenerate、bundle/original limit
  - 文件：`apps/api/src/exports/**`, `apps/api/src/routes/exports.ts`, `apps/api/src/workers/export-worker.ts`, `apps/api/test/exports-*.test.ts`, `assets/fonts/**`
  - Spec：`01_design_spec.md` §5.6；`02_api_contracts.md` §8；`03_database.md` §8
  - Wiki 引用：architecture-data-and-security
  - verify (auto)：`pnpm --filter @amr/api test -- export`
  - verify (manual)：A4/PDF 与 PNG 一页纸内容一致
  - status：固定 renderer/font、拥挤 PDF 单页与 PNG 1240×1754 边界已自动验证；医生可读性纳入 P4-12 人工 gate。

- [x] **[M] Share security**：owner-only、256-bit token/hash、一次返回、重复 op null、expiry/revoke、no-store/rate-limit/log redaction
  - 文件：`apps/api/src/services/export-shares.ts`, `apps/api/src/routes/shared-exports.ts`, `apps/api/test/export-shares.test.ts`
  - Spec：`02_api_contracts.md` §8；`04_acceptance.md` P4-9..10
  - Wiki 引用：architecture-data-and-security
  - verify (auto)：`pnpm --filter @amr/api test -- export-shares`
  - verify (manual)：访问日志抽查无 token/person/文件名
  - status：API 与真实浏览器已覆盖 owner/editor/viewer、token 一次显示、撤销/过期/未知统一 404、no-store 和限流；发布前仍抽查实际部署访问日志。

- [ ] **[L] P4 Web**：数据页用药/事件、导出 preview/progress/retry/stale、viewer 历史、owner 分享/撤销/风险确认
  - 文件：`apps/web/src/features/data/**`, `apps/web/src/features/exports/**`, `apps/web/src/api/client.ts`, `apps/web/src/App.tsx`
  - Spec：`05_ux_states.md` §1, §6
  - Wiki 引用：none
  - verify (auto)：`pnpm --filter @amr/web typecheck && pnpm --filter @amr/web test`
  - verify (manual)：preview→下载用户操作 ≤30 秒；角色矩阵；移动端
  - status：实现与真实 Chromium P4-W1..13 已通过；保留未勾选，等待 owner ≤30 秒、主观桌面/手机与实际下载内容核对。
  - manual pack：`MANUAL-ACCEPTANCE.md`、`manual-evidence.template.json` 与合成 PDF/PNG 已就绪；`core:manual-evidence` 不允许缺证据或超时结果通过。

- [ ] **[L] P4/full core acceptance**：P0–P4 no-AI e2e、删库恢复、确定性、权限、分享隔离和大数据状态
  - 文件：`tools/src/core-acceptance.ts`, `infra/run-core.sh`, `specs/p0-p4-core/RESULTS.md`
  - Spec：`04_acceptance.md` 全文
  - Wiki 引用：none
  - verify (auto)：`pnpm typecheck && pnpm test && pnpm core:acceptance`
  - verify (manual)：3–5 名医生脱敏样例“3 秒定位”；20 份真实单据仍属于后续 plugin/field validation
  - status：无 AI 自动总验收 Core 100/100、浏览器 47/47、两轮删库重建等价已通过；保留未勾选，P4-12 医生可读性是发布硬门槛。
  - manual pack：合成样张只用于预演；正式 P4-12 仍要求 3–5 名医生与至少 1 份脱敏真实样例，不要求 20 份真实单据。

## Final verification and documentation

- [x] **[M] Source docs/ADR/wiki sync**：传播 AI 辅助边界、API/schema/部署、功能状态与验收结果
  - 文件：`docs/{00-vision-and-scope,01-architecture,03-data-model,05-capture-and-context,06-ai-pipeline,07-api-contract,09-roadmap,11-deployment,adr}.md`, `agent_wiki/**`, `feature_wiki/**`
  - Spec：`01_design_spec.md` §10
  - Wiki 引用：typed knowledge lifecycle
  - verify (auto)：`git diff --check && pnpm typecheck`
  - verify (manual)：文档不再把 AI/M2 当作 P0–P4 前置 gate

- [x] **[L] Final code review**：按 completeness/correctness/consistency 审查全部实现与验收证据
  - 文件：全部 task diff、`specs/p0-p4-core/review-code.md`
  - Spec：`review-002.md` 与 `04_acceptance.md`
  - Wiki 引用：architecture-data-and-security、相关 feature wiki
  - verify (auto)：`pnpm typecheck && pnpm test && pnpm core:acceptance && git diff --check`
  - verify (manual)：所有未自动化 gate 明确 owner/证据，不虚报完成
  - status：`review-code.md` 对自动化实现给出 PASS；整体发布状态仍为 CONDITIONAL，等待明确列出的 owner/医生人工 gate。

---

## Complexity

- **[M]**：边界明确但涉及多个调用点。
- **[L]**：migration、权限、journal/rebuild、队列或跨端闭环，必须独立验证后才进入下一项。
