# Design Review 001 · P0-P4 Core

日期：2026-08-28  
结论：**FAIL — 修订后复审，禁止进入编码**

## 审查方式

- 主审查：以原始设计、现有 schema/journal/rebuild、当前 Web 离线结构为证据。
- 独立技术审查：Codex reviewer `p0_p4_tech_review`。
- 独立 UX/业务审查：Codex reviewer `p0_p4_ux_biz_review`。
- MCP-LSP：当前环境未暴露；使用 `rg`、定点源码读取与后续 typecheck 作为 fallback。
- 外部 advisor：未调用；本轮没有必须依赖外部事实的设计决策。

## 已通过的方向

1. AI 仅为建议、预填、转写、OCR、语义增强；不成为 P0-P4 核心 gate。
2. Core acceptance 与 Plugin qualification 分轨。
3. L1 人工事实可回放，L2/L3 可删除重生。
4. 趋势和导出只消费人工录入、导入或明确接受的事实。

## BLOCKER

1. 离线现场问答只接受服务端 `document_id`，无法从现有 `client_document_id` 启动与恢复。
2. 非 AI 概念归一缺少确定性 catalog/search、人工 alias 决策和未映射整理队列。
3. 元数据 suggestion 没有稳定实体；逐字段 value/source/provenance、旧建议批量迁移与撤销无法实现。
4. observation 字段、时间精度、稳定页来源和派生依赖不足；split/merge/move 后可能回链错误。
5. P4 用药/关键事件没有 L1 事实来源和人工 API。
6. 现有 `human_operation` 强绑 document，不能支撑 person/session/group 级幂等；写 API 未冻结统一 revision 冲突协议。
7. context audio/photo 缺安全的 prepare/upload/finalize 完整性与归属协议。
8. `export_job` 缺 claim/lease/retry、输入/renderer/font provenance 和对象缺失后的重生语义。
9. 旧 `ai_job` 含家庭级任务，不能无损迁入强制 person 的通用队列。
10. 搜索缺可重建的统一投影、通用 result subject 与稳定 cursor/index。

## SHOULD-FIX

1. 移动导航不能扩成七个平级入口；采集必须保持全局主动作。
2. 10 行人工录入需表格粘贴、报告级继承、确定性解析、复制上一行和定量耗时 gate。
3. 缺少 capability 请求失败、模板未缓存、麦克风拒绝、PDF、趋势空态、大数据与分享权限状态矩阵。
4. 公开分享应 owner-only、限流、token 日志脱敏并明确范围/期限/风险。
5. 当天补录、条件题、“三高+”预置、导出预览与 stale 标识需恢复到路线图承诺。

## 决策

- suggestion 采用 **L2 数据库索引行 + 可选 S3 原始工件**；接受动作将完整字段快照和逐字段 provenance 复制入 L1 journal，因此删除 L2 后事实仍可回放。
- 旧 `ai_job` **不做有损转换**：兼容发布先原位 drain/冻结；新任务进入 `processing_job`；历史 confirmed decision 保持 L1 可回放。
- 所有可编辑 L1 投影使用整数 `revision`；冲突返回 base/current/draft。
- 页面来源用 page SHA-256 与 capture 身份定位，`document_id/page_no` 仅为当前导航投影。
- 公开分享仅 owner 可创建/撤销；editor 可生成导出，viewer 仅下载已授权内部导出。

## 修订要求

以上 BLOCKER 必须全部写入 `01_design_spec.md`、`02_api_contracts.md`、`03_database.md`、`04_acceptance.md` 及新的 UX 状态矩阵，并经过第二轮独立复审。复审通过前不修改业务代码。
