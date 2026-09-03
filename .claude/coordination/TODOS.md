# TODOS

跨 session 的延期事项。`/todo` 查看，`/todo add` 添加。

## Active

- [ ] **#2** `2026-09-08` **P1** · P5 真实单据对照基准（M5）
  - origin: task-pause @ 2026-08-31 (claude-code)，2026-09-01 改期改素材
  - context: P5 裁切已发布并通过部署验收，但**收益尚未证明** — 合成图上裁与不裁识别结果完全一致（字号偏大，26% 占比下也认得出）。机制通了，增益没通。
  - ⚠️ **素材已变更**：原计划用 8-30 那 6 份真实单据，但它们的 S3 原件已随 2026-08-31 全量重置永久删除（owner 授权，确认为纯测试）。快照 `amr-before-reset-20260831-0624.sql.gz` 只有数据库行，没有图像字节。
  - 改为：等 owner 上传新的真实单据后，同一份各跑裁 / 不裁多轮，比对姓名、`sampled_on`、facility 与数值字段。重点看小数点与 `10⁹/L` 上标。
  - 取"不裁"对照的两种方式：预览里点「本页不裁」，或对同一原件直接调 `renderDerivative(source, 'ai', null)`。
  - 若增益不成立：ADR-052 需补一条"实测未兑现"，并重新评估是否值得保留检测器的 3.9 MB 与这套交互。
  - link: specs/p5-capture-crop/docs/context-manifest.yaml (U1)

- [ ] **#3** `2026-09-02` **P2** · 任务文档入版本控制
  - origin: task-pause @ 2026-09-01 (claude-code)
  - context: P5 裁切功能已发布（`193ce8a`），但任务状态文件是在发布之后才建的，目前全部 untracked：`specs/p5-capture-crop/CLAUDE.md`、`specs/p5-capture-crop/docs/context-manifest.yaml`、`.claude/coordination/TODOS.md`。换机器或清工作区就丢了。
  - 做什么：`git add` 上述三处并提交。建议 message: `docs(task): track p5-capture-crop state and the shared TODO list`
  - 注意：`.claude/` 目前不在 `.gitignore` 里，提交前确认该目录下没有本机私有配置（本次只有 `coordination/TODOS.md`）。

## Done

- [x] **#1** `2026-08-31 完成` **P1** · 清理测试数据（在上传真实数据之前）
  - origin: task-pause @ 2026-08-31 (claude-code)
  - context: P5 裁切功能发布后，验收脚本与历史冒烟在部署实例留下大量测试档案。owner 已授权清理 `kuno.xiang@gmail.com` 账户下全部既有数据（确认为纯测试）。
  - ⚠️ **顺序约束**：owner 表示接下来要上传真实数据。清理**必须先于**那次上传，否则"清空该账户全部数据"会连真实数据一起扫掉。
  - 范围（2026-08-31 盘点）：
    - `kuno.xiang@gmail.com`：4 人 6 文档 — pxvmsm 向坤(5 文档/17 对象)、pskjth 向沐然(1/5)、pff4ej 莫雪迎(0/2)、pndamc 向昕然(0/2)
    - `owner@medireco.local`：11 人 — 9 个 `冒烟-*` + 2 个 `裁边验收-*`（本次 P5 验收产生），全部为脚本合成，owner 未明确授权但显属可清
  - 前置：S3 对象带 GOVERNANCE 保留锁至 2036，删除需 `BypassGovernanceRetention`；`infra/.env.local` 已配置 `S3_ADMIN_KEY/SECRET`
  - link: specs/p5-capture-crop/CLAUDE.md
  - ✅ 2026-08-31 全量重置：桶清空 504 个版本/标记（含 GOVERNANCE 锁，管理档凭证 bypass）、public+drizzle schema 重建、20 个迁移从零重放、桶重新 provision、`_meta` 重生成、工具账户重新 seed。结果：0 person / 0 document / 0 operation，桶内仅 `_meta`(9) + `_probe`(6)。空实例启动无报错。
