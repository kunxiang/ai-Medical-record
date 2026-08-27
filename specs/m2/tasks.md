# Implementation Tasks: M2 AI metadata and reconciliation

> Generated from frozen M2 specs on 2026-08-26
> Review status: 通过（`review-004.md` 的 A/B/C 裁决已回写；实现期偏差记入 `CHANGES.md`）
> REQUIRED_SKILL_ROUTE: `fullstack`（按 backend → frontend 推进）
> Wiki constraints: `agent_wiki/architecture-data-and-security.md`、`agent_wiki/runtime/m2-implementation-status.md`、`feature_wiki/ai-metadata-and-jobs.md`

## Milestone 0: M0/M1 正式关闭

- [x] **[S] [docs] Owner acceptance**: 记录项目所有者对 M0/M1 的验收决定
  - 文件: `specs/m0/RESULTS.md`, `specs/m1/RESULTS.md`, `docs/09-roadmap.md`, `README.md`
  - Spec: `specs/m0/RESULTS.md` C 组；`specs/m1/RESULTS.md` C 组
  - Wiki 引用: `feature_wiki/capture-archive-and-browse.md`
  - verify (auto): `rg -n "M0 关闭|M1 关闭|M0/M1 已验收" specs/m0/RESULTS.md specs/m1/RESULTS.md README.md`
  - verify (manual): 项目所有者已在 2026-08-26 明确确认可验收

## Milestone 1: AI 元数据链可运行、可继续编排

- [x] **[S] [backend] Schema**: 持久化 `facility_name_raw` L2 字段并生成 Drizzle 迁移
  - 文件: `apps/api/src/db/schema.ts`, `apps/api/drizzle/*`, `docs/03-data-model.md`
  - Spec: `specs/m2/03-stage1.md` §6；`specs/m2/05-reconciliation.md` §2；`CHANGES.md` #5
  - Wiki 引用: `agent_wiki/architecture-data-and-security.md`（L2 可重算）
  - verify (auto): `pnpm --filter @amr/api typecheck && pnpm --filter @amr/api test`
  - verify (manual): —

- [x] **[M] [backend] Stage 1 orchestration**: S1 落库原始机构名，并在同一事务投递 facility 归一作业
  - 文件: `apps/api/src/jobs/stage1-handler.ts`, `apps/api/src/jobs/queue.ts`
  - Spec: `specs/m2/04-jobs.md` §2/§4；`specs/m2/05-reconciliation.md` §2/§3
  - Wiki 引用: `agent_wiki/runtime/m2-implementation-status.md`
  - verify (auto): `pnpm --filter @amr/api test`
  - verify (manual): —

## Milestone 2: Facility 归一闭环

- [x] **[S] [backend] Contracts**: 补齐 facility 提议、列表与确认响应 schema
  - 文件: `packages/contracts/src/normalization.ts`, `packages/contracts/src/index.ts`
  - Spec: `specs/m2/01-contracts-delta.md` §1/§4；`specs/m2/05-reconciliation.md` §2
  - Wiki 引用: `agent_wiki/architecture-data-and-security.md`（判断/执行分离）
  - verify (auto): `pnpm --filter @amr/contracts test && pnpm --filter @amr/contracts typecheck`
  - verify (manual): —

- [x] **[M] [backend] AI proposal**: 新增版本化 facility prompt 与可注入 transport 调用
  - 文件: `packages/ai/prompts/facility/*`, `packages/ai/src/*`, `packages/ai/test/*`
  - Spec: `specs/m2/02-ai-client.md` §1/§4/§5；`specs/m2/05-reconciliation.md` §2
  - Wiki 引用: `feature_wiki/ai-metadata-and-jobs.md`
  - verify (auto): `pnpm --filter @amr/ai test && pnpm --filter @amr/ai typecheck`
  - verify (manual): prompt 不含医学判断且版本/哈希一致

- [x] **[L] [backend] Facility service/handler**: 实现指纹缓存、AI 首次提议、facility 确定性 upsert 与同指纹文档批量回填
  - 文件: `apps/api/src/normalization/*`, `apps/api/src/jobs/facility-handler.ts`, `apps/api/src/jobs/worker.ts`
  - Spec: `specs/m2/05-reconciliation.md` §2；`specs/m2/99-acceptance.md` A15–A17
  - Wiki 引用: `agent_wiki/architecture-data-and-security.md`（AI 判断，确定性执行）
  - verify (auto): `pnpm --filter @amr/api test`
  - verify (manual): 相同机构原文第二次不得调用模型

- [x] **[M] [backend] L1 decisions**: 实现 `_index/decisions` 追加与确认/拒绝 API 的 DB+S3 双写
  - 文件: `apps/api/src/journal.ts`, `apps/api/src/routes/normalization.ts`, `apps/api/src/server.ts`
  - Spec: `specs/m2/01-contracts-delta.md` §4.2；`specs/m2/05-reconciliation.md` §2.5；`specs/m2/07-replay.md` §5
  - Wiki 引用: `agent_wiki/architecture-data-and-security.md`（人工判断属 L1）
  - verify (auto): `pnpm --filter @amr/api test`
  - verify (manual): 确认载荷足以重建 facility 与 aliases

- [x] **[M] [frontend] Facility review UI**: 展示待确认机构映射并支持确认/拒绝
  - 文件: `apps/web/src/api/client.ts`, `apps/web/src/features/browse/*`, `apps/web/src/styles.css`
  - Spec: `specs/m2/05-reconciliation.md` §2.4/§2.5
  - Wiki 引用: `feature_wiki/ai-metadata-and-jobs.md`
  - verify (auto): `pnpm --filter @amr/web typecheck && pnpm --filter @amr/web build`
  - verify (manual): 手机与桌面均能辨认“待确认/已确认/已拒绝”

## Milestone 3: Encounter 归组建议闭环

- [x] **[M] [backend] Candidate engine**: 按真实时分/日期区间规则生成 person 级未归组候选集
  - 文件: `apps/api/src/normalization/encounter-candidates.ts`, `apps/api/test/*`
  - Spec: `specs/m2/05-reconciliation.md` §3.1–§3.4；`specs/m2/99-acceptance.md` A18a–A19b
  - Wiki 引用: `agent_wiki/architecture-data-and-security.md`
  - verify (auto): `pnpm --filter @amr/api test`
  - verify (manual): —

- [x] **[L] [backend] Suggestion handler**: 将候选交给版本化 AI 判断并持久化 `kind='encounter'` 提议，禁止自动建 encounter
  - 文件: `packages/ai/prompts/encounter/*`, `packages/ai/src/*`, `apps/api/src/jobs/encounter-handler.ts`, `apps/api/src/jobs/worker.ts`
  - Spec: `specs/m2/05-reconciliation.md` §3.5/§3.6
  - Wiki 引用: `agent_wiki/architecture-data-and-security.md`（M2 只做建议）
  - verify (auto): `pnpm --filter @amr/ai test && pnpm --filter @amr/api test`
  - verify (manual): 未确认前 `encounter` 表不得新增行

- [x] **[M] [fullstack] Encounter confirmation**: 确认后创建 encounter、写 `grouping_basis` 与 decisions；UI 标注弱判据
  - 文件: `apps/api/src/routes/normalization.ts`, `apps/web/src/features/browse/*`
  - Spec: `specs/m2/05-reconciliation.md` §3.6；`specs/m2/99-acceptance.md` A18/A19
  - Wiki 引用: `feature_wiki/ai-metadata-and-jobs.md`
  - verify (auto): `pnpm typecheck && pnpm test`
  - verify (manual): 降级候选显示“判据较弱”，拒绝不创建 encounter

## Milestone 4: 人工纠正与文档治理

- [x] **[M] [fullstack] Person mismatch actions**: 实现告警 ack 与归人纠正，journal/correction/manifest 幂等双写
  - 文件: `apps/api/src/routes/documents.ts`, `apps/web/src/features/browse/*`, `tools/src/rebuild-index.ts`
  - Spec: `specs/m2/05-reconciliation.md` §1.8；`specs/m2/06-corrections.md` §2
  - Wiki 引用: `agent_wiki/architecture-data-and-security.md`（AI 禁止改 person_id）
  - verify (auto): `pnpm test`
  - verify (manual): ack 后重跑不重现告警；纠正需明确二次确认

- [x] **[M] [fullstack] Soft archive**: 文档归档/撤销、列表过滤、直访保留及 journal+audit 双写
  - 文件: `apps/api/src/routes/documents.ts`, `apps/web/src/features/browse/*`
  - Spec: `specs/m2/06-corrections.md` §1；`specs/m2/99-acceptance.md` A20
  - Wiki 引用: `agent_wiki/architecture-data-and-security.md`（L1 不删除）
  - verify (auto): `pnpm test`
  - verify (manual): 归档文档默认隐藏但仍可恢复查看

- [x] **[L] [backend] Document boundaries**: 实现 split/merge/move-page、correction sidecar、派生物失效和幂等
  - 文件: `packages/contracts/src/{corrections,sidecars,enums}.ts`, `apps/api/src/{document-boundaries.ts,routes/corrections.ts}`, `tools/src/rebuild-index.ts`
  - Spec: `specs/m2/06-corrections.md` §3；`specs/m2/99-acceptance.md` A21/A21b/A32
  - Wiki 引用: `agent_wiki/architecture-data-and-security.md`（原件字节零改动）
  - verify (auto): `pnpm test`
  - verify (manual): 移页后预览不得显示旧页内容
  - Wiki source: `feature_wiki/ai-metadata-and-jobs.md` @ `338a4e729f5ae3c22f6505e4caa54eca99c31b66`；同步状态 `awaiting owner`，发布与入索引后的检索验证负责人为项目所有者

## Milestone 5: PDF 与弱网大文件

- [x] **[L] [backend] PDF Stage 1**: 正常 PDF 走 document block，超限进入 unsupported
  - 文件: `packages/ai/src/{stage1,transport}.ts`, `packages/ai/prompts/s1/s1-classify@2.md`, `apps/api/src/{pdf-stage1.ts,jobs/stage1-handler.ts}`, `packages/ai/test/*`, `apps/api/test/stage1-pdf.test.ts`
  - Spec: `specs/m2/02-ai-client.md` §3.5；`specs/m2/03-stage1.md` §1.6；`specs/m2/99-acceptance.md` A14b/A26
  - Wiki 引用: `feature_wiki/ai-metadata-and-jobs.md`
  - verify (auto): `pnpm --filter @amr/ai test && pnpm --filter @amr/api test`
  - verify (manual): —

- [x] **[L] [fullstack] Multipart resume**: >8 MiB 三段式上传与 IndexedDB 分片恢复
  - 文件: `packages/contracts/src/{document,multipart}.ts`, `apps/api/src/{multipart-planning.ts,routes/multipart.ts,routes/documents.ts}`, `apps/web/src/{api/client.ts,offline/*}`
  - Spec: `specs/m2/06-corrections.md` §4；`specs/m2/99-acceptance.md` A22
  - Wiki 引用: `feature_wiki/capture-archive-and-browse.md`
  - verify (auto): `pnpm typecheck && pnpm test`
  - verify (manual): 中断刷新后只续传未完成分片
  - Wiki source: `feature_wiki/capture-archive-and-browse.md` @ `338a4e729f5ae3c22f6505e4caa54eca99c31b66`；同步状态 `awaiting owner`，发布与入索引后的检索验证负责人为项目所有者

## Milestone 6: L1 回放与 M2 总验收

- [x] **[S] [ops] Runtime credential**: 让 API 容器读取非空视觉提供方凭证，重跑失败 S1 并验证一个真实 job 到 `done`
  - 文件: `infra/.env.local`（Git 忽略，不提交）, `infra/docker-compose.medireco.yml`
  - Spec: `specs/m2/02-ai-client.md` §1；`docs/11-deployment.md` §2
  - Wiki 引用: `feature_wiki/ai-metadata-and-jobs.md` Operation Guide
  - verify (auto): `docker exec ai-medical-record-api-1 sh -lc 'test "$AI_PROVIDER" = deepseek && test -n "$DEEPSEEK_API_KEY"'`
  - verify (manual): 2026-08-27 项目所有者明确授权生产医疗图片/PDF 发送至 DeepSeek；真实 JPEG job 到 `done`，工件 model=`deepseek-v4-flash-vision-exp`；密钥未进日志或仓库

- [ ] **[L] [backend] Human-layer replay**: 回放 archive/ack/normalization，未知事件继续，零 AI 调用
  - 文件: `tools/src/rebuild-index.ts`, `tools/src/verify-rebuild.ts`
  - Spec: `specs/m2/07-replay.md`；`specs/m2/99-acceptance.md` A33–A35/B13/B15
  - Wiki 引用: `agent_wiki/architecture-data-and-security.md`（PostgreSQL 可由 L1 重建）
  - verify (auto): `pnpm --filter @amr/tools test && pnpm --filter @amr/tools typecheck`
  - verify (manual): —

- [ ] **[L] [test] Acceptance harness**: 建立 cassette、PII 扫描、A/B 自动验收和 C 组基线入口
  - 文件: `fixtures/m2/*`, `tools/src/m2-acceptance.ts`, `infra/run-m2.sh`, `package.json`, `specs/m2/RESULTS.md`
  - Spec: `specs/m2/99-acceptance.md`
  - Wiki 引用: `feature_wiki/ai-metadata-and-jobs.md`
  - verify (auto): `pnpm m2:acceptance`
  - verify (manual): 项目所有者提供至少 20 份脱敏真实单据并确认替换策略

- [ ] **[M] [docs] Close M2**: A/B 全绿、C 基线入库后更新 roadmap、wiki 和部署说明
  - 文件: `specs/m2/RESULTS.md`, `docs/09-roadmap.md`, `docs/11-deployment.md`, `agent_wiki/*`, `feature_wiki/*`
  - Spec: `specs/m2/99-acceptance.md` 完成定义
  - Wiki 引用: `agent_wiki/runtime/m2-implementation-status.md`
  - verify (auto): `rg -n "M2.*关闭|A\(42 项\).*全绿" specs/m2/RESULTS.md docs/09-roadmap.md`
  - verify (manual): 项目所有者确认 C 组基线可接受（不设准确率门槛）

## Complexity Legend

- **[S]** Small: < 30 min, straightforward
- **[M]** Medium: 30–60 min, some logic
- **[L]** Large: > 60 min, complex integration

## Code Review Log

| 日期 | 结论 | 证据与限制 |
|---|---|---|
| 2026-08-26 | 有条件通过（Milestone 1–3、Milestone 4 前两项） | 完整性/正确性/一致性三维复核；修正时区日界、L1 event 幂等、审核 UI 文案及运行中 job dirty 竞态。实际运行 `pnpm typecheck`、`pnpm test`、`pnpm build`、Web production build、`git diff --check` 全部通过。MCP-LSP 未暴露，使用 `rg`、目标文件抽查与 TypeScript 编译兜底；未启用 subagent，未调用外部 advisor。真实 PostgreSQL/S3/Anthropic 端到端验收仍待运行环境与凭证。 |
| 2026-08-26 | 有条件通过（Milestone 4 文档边界） | split/merge/move-page、page_move correction、严格 derived 前缀删除、幂等台账与重建回放已实现；新增规划/契约测试。`pnpm typecheck`、`pnpm test`、`pnpm build`、`git diff --check` 全绿。规格中“共用源目录且各有 capture.json”的 WORM key 冲突已按 `CHANGES #9` 修正。尚未在本机真实 S3 文档上执行会修改用户测试数据的边界操作，移页后预览人工验收仍待项目所有者使用专用测试文档完成。 |
| 2026-08-26 | 通过（Milestone 5 PDF Stage 1） | 正常 PDF 使用单个 base64 document block；服务端以 `pdf-lib` 校验内部物理页数，32 MiB/600 页超限直接 `unsupported`，模型输出必须恰好覆盖 `1..N`，数据库不展开 PDF 页。S1 prompt 升 v2；32k 提额改为真实流式路径。AI/API 目标测试、全仓类型/测试/构建门禁通过；真实模型调用仍受部署凭证门禁约束。 |
| 2026-08-26 | 有条件通过（Milestone 5 Multipart resume） | `>8 MiB` 不再获得单 PUT URL，固定 8 MiB 分片；create/sign/complete 经鉴权，服务端完成后 GET 回流校验整文件 SHA-256，IndexedDB 持久化 UploadId/ETag 并只重传缺失 part；补齐 complete 已成功但 DB 未落盘的恢复窗口。contracts 26/26、API 34/34、Web 3/3 目标测试及各包类型检查通过。真实 12 MiB 对象存储中断刷新冒烟与 owner 浏览器验收仍待当前工作树发布到测试部署后执行。 |
