# M2 Spec · 99 验收清单

环境:M1 的 compose(PG16 + MinIO)。入口 `pnpm m2:acceptance` → `infra/run-m2.sh`。

> **M2 的验收分两类,不可混淆**([00](./00-scope.md) §6):
> **A/B 组 = 工程正确性,必须 100% 通过。**
> **C 组 = 提取质量,只测量、只记录基线,不设通过线。** 任何把"准确率 ≥ X%"写成通过条件的实现,视为 A 档偏差。

## 0. 前置:模型调用的隔离

真实调用 Claude API 会让验收变慢、变贵、且**不确定** —— 同一输入两次运行结果可能不同,而 A 组断言的是工程正确性,不是模型输出。因此:

1. **必须**提供 `packages/ai` 的注入点 `setTransport(fn)`,默认是真实 SDK。
2. A/B 组 **必须**用**录制回放** transport:首次以 `AMR_AI_RECORD=1` 真实调用并把请求/响应落 `fixtures/m2/cassettes/{hash}.json`,此后按请求指纹回放。指纹 **必须**包含 `model`、`prompt_sha256`、图像 key 与页序。
3. **禁止** A/B 组断言依赖真实网络。C 组**必须**真实调用(它测的就是模型质量)。
4. 录制盒 **必须**提交进仓库(它们是行为基准,与 fixtures 同等地位),但 **必须**先经确定性代码剥除 `pii_spans` 覆盖的字符 —— 回归资产不得携带真实 PII。

## A. 端到端(工程正确性)

| # | 步骤 | 断言 |
|---|---|---|
| A1 | 上传一份带 `Orientation=6` 的单页文档 | `derived/{slug}/{sid}/ai-01.webp` 存在;其像素**高 > 宽**(已旋正);长边 ≤ 2576;`sharp().metadata().exif` 为空 |
| A2 | 检查送进模型的请求 | 图像块 URL 指向 `ai-01.webp` **而非** L1 原件;image 块排在 text 块之前;**未**出现 base64 图像源 |
| A3 | 登记后立即查 job | `ai_job` 恰 1 行,`kind='stage1'`、`state='pending'`;**同事务投递**:回滚登记事务后 job 行不存在 |
| A4 | 跑完 S1 | job → `done`;`derived/{slug}/{sid}/extractions/s1@{v}.json` 存在;含 `model`/`prompt_id`/`prompt_version`/`prompt_sha256`/`effort`/`usage` 六项,缺一即失败 |
| A5 | 落库 | `document.doc_type ≠ 'unknown'`;`s1_artifact_key` 非空;**`person_id` 与登记时逐字节相同**(AI 不得改归属) |
| A6 | `full_text` 落点 | 数据库中**不存在**任何列含全文;全文只在 S1 工件内 |
| A7 | 重复投递 | 同 `(document_id,'stage1')` 再投递 → job 仍 1 行(唯一索引生效) |
| A8 | 僵尸回收 | 手工把 job 置 `running` 且 `locked_at` 回拨 20 分钟 → 回收器将其置回 `pending` 且 `attempt` +1 |
| A9 | PII 未外泄 | 回放一份含手机号的单据:`derived/**/extractions/` **之外**的任何 S3 对象与任何 DB 列中都不出现该手机号;`pii_spans` 中有对应 `phone` 条目 |
| A10 | 归人对账 · 一致 | 姓名一致 → `person_check='match'`,无告警 |
| A11 | 归人对账 · 不一致 | 姓名不一致 → `person_check='mismatch'`;**`person_id` 未变**;`GET /documents?person_check=mismatch` 能列出它 |
| A12 | 归人告警确认 | `person_check_ack` → `person_check='skipped'`;journal 恰增一行该事件 |
| A13 | 归人纠正(D15) | `POST /documents/:id/reassign` → 原目录新增 `correction-0001.json`;manifests 增一条修正行;**原件、`capture.json`、`page-NN.json` 的 (Key,VersionId,ETag) 逐字节不变** |
| A14 | 纠正后重建 | 删库 → migrate → seed → rebuild → 该文档归属为**纠正后**的 person(最后写入者胜);旧归属未复活 |
| A15 | facility 归一 · 首次 | 未命中决策缓存 → 调 AI → `normalization_decision` 新增 `proposed` 行;`document.facility_id` 已写 |
| A16 | facility 归一 · 复用 | 同 `input_fingerprint` 再来一份 → **不再调用 AI**(回放 transport 计数为 0);直接复用决策 |
| A17 | 归一确认 | 人工确认 → `state='confirmed'`;journal 增 `normalization_confirm` 一行 |
| A18 | encounter 归组 | 同人同院、`event_time` 差 11h → 产生建议;差 13h → 不产生。**未**自动建 `encounter` 行 |
| A19 | 跨日就诊不被拆开 | 23:50 与次日 00:30 两份 → 仍在同一建议组内(证明用的是时间窗不是日历日) |
| A20 | 软删除 | `PATCH {archived:true}` → 列表默认不返回;`?include_archived=true` 返回;直访仍 200;派生物端点仍可用;journal + audit 各增一行 |
| A21 | 拆分(D7) | `POST /split` → 新文档页序从 1 连续;**`capture_order` 未改动**;原件字节不变;重复提交同 `client_operation_id` 返回首次结果且不产生第二次拆分 |
| A22 | 分片续传(D14) | 12 MiB 文件走三段式;在第 2 片后中断并刷新 → 续传完成;最终 sha256 与源文件一致;`_incoming` 无残留 |
| A23 | 拒绝路径 | 注入 `stop_reason='refusal'` → job 直接 `needs_human`,`last_error.category` 已记录,**未**重试 |
| A24 | 超长输出 | 注入 `stop_reason='max_tokens'` → 以 32000 重试一次;再失败 → `needs_human` |
| A25 | 超 20 页分批 | 25 页文档 → 分 2 批,每批 ≤ 20;合并后 `pages` 恰 25 条且 `page_no` 无重复;工件含 `batches: 2` |
| A26 | 超限 PDF | 700 页 PDF → job `unsupported`,不重试,可在 `GET /jobs` 中查到 |
| A27 | **L2 可整体丢弃** | 删光 `derived/**` 与全部 `ai_job` 行 → 重跑 → S1 工件与 DB 派生列恢复;**L1 快照逐字节不变** |
| A28 | **L1 零字节变动(A 组全程)** | A 组开始时取 `people/**` 的 (Key,VersionId,ETag) 全量清单,结束时再取,逐字节相同 |
| A29 | 越权 | 他人文档的 `/ai`、`/rerun`、`/reassign` 一律 404,且与不存在不可区分 |
| A30 | 矩阵覆盖 | 桶内对象 ⊆ 权威矩阵(`parseKey` 全通过,含新增 `ai-NN.webp` 与 `extractions/` 两类 key) |

## B. CI 断言

| # | 断言 |
|---|---|
| B1 | `packages/ai` 只依赖 `@anthropic-ai/sdk` 与 `@amr/contracts`;不 import `@amr/api` / `@amr/storage` |
| B2 | 模型 ID 只在 `packages/ai/src/models.ts` 出现一次;全仓无内联 `claude-` 字面量(除该文件与文档) |
| B3 | **缓存生效**:连续两次同 prompt 调用,第二次 `usage.cache_read_input_tokens > 0` |
| B4 | **prompt 完整性**:篡改任一 prompt 文件而不改 `manifest.json` → 启动失败 |
| B5 | 新增 7 个 journal 事件在 `_meta/schemas`、`_meta/registries`、`_meta/README.md` 三处齐备 |
| B6 | 新增枚举与迁移 CHECK 值列表逐字相同(m0-99 B2 扩展) |
| B7 | `drizzle-kit generate` 无漂移(m1-99 B7) |
| B8 | **`appendJournal` 不覆盖调用方 `event_id`** 的回归单测(M1 已修缺陷,不得回归) |
| B9 | Stage1 schema 全部 `.strict()`:注入未知键 → 校验失败 |
| B10 | **禁止 Stage 2 泄漏**:全仓 grep 无 `observation` 表写入、无单位换算调用(M2 边界) |
| B11 | `ai` 变体生成的确定性:同一源图两次生成,sha256 相同 |
| B12 | 合并规则单测:25 页分 2 批的合并结果与单批送 25 页的字段选取规则一致(`page_no` 冲突时失败) |

## C. 提取质量(测量,不设通过线)

回归集:`fixtures/m2/regression/`,**必须** ≥ 20 份真实单据(项目所有者提供,经 PII 剥除后入库),覆盖化验单/影像/处方/输液单/体检至少各 2 份。

| # | 测量项 | 记录方式 |
|---|---|---|
| C1 | `doc_type` 准确率 | 混淆矩阵 + 总体准确率 |
| C2 | `sampled_on` / `reported_on` 准确率 | 精确匹配率;null 率单列 |
| C3 | `facility_name_raw` 准确率 | 精确匹配率 |
| C4 | `patient_name` 准确率 | 精确匹配率(直接决定归人对账的误报率) |
| C5 | `full_text` 覆盖率 | 人工标注的关键字段在全文中的命中率 |
| C6 | `doc_type_confidence` 的可用性 | 置信度分箱 vs 实际准确率(校准曲线);**若高置信区间的准确率不高于低置信区间,则该字段不可用于任何自动决策,须在 RESULTS 中写明** |
| C7 | 单页成本 | `usage` 实测均值与 $/页 |

结果 **必须**写入 `specs/m2/RESULTS.md` 作为基线。M5 设阈值时以此为起点。

## 完成定义

A(30 项)+ B(12 项)全绿,C 组基线已记录,D7/D14/D15/软删除四笔设计债勾销 → M2 关闭。
