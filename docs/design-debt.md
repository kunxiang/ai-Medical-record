# 设计债登记

来源:2026-08 三方对抗性独立审核(C 档)。每项绑定里程碑验收,完成后勾销;**到期未清不得进入下一里程碑**。

| # | 债 | 审核来源 | 绑定 | 验收标准 |
|---|---|---|---|---|
| D1 | ~~人工层统一 journal~~ **已由 ADR-045 收编并扩容**(增补手动 observation、metric_group、person 编辑三笔漏账):journal 与产生数据的功能**同里程碑双写**,自 M1 起 | C3 / B3 / 二轮审核 | ~~M8 前~~ **M1 起逐里程碑** | 每个里程碑的恢复演练:该里程碑新增人工输入**零丢失**(0.86 的修正不得变回 8.6) |
| D2 | **决策失效反向传播**:confirmed → rejected/superseded 时自动枚举受影响 observation → 从提取层重放 → 差异报告 | B3 | M5 | 改判一条决策,下游自动重放并出报告 |
| D3 | **n=1 规则降级**:规则带 `evidence_scope`(机构/仪器/样本量);Tier 0 前提不成立时显式上报"防线未激活";`report_no` 去重降级为提示,**绝不自动拒收** | B6 | M5(第二家医院首份单据前) | 无 NO 列的单据不静默降级;撞号不丢档 |
| D4 | **确认队列可用性**:模式级晋升(一次确认批量生效)、逐报告聚合确认视图、未确认时的渲染降级规则显式化 | B7 | M5 | 100 份冷启动的确认总耗时可接受 |
| D5 | **长文档**:页级 full_text 与 embedding、搜索返回 page_no、checkup 分节模型(parent_document_id 或 sections[]) | C5 / A F7 | M4 | 新增 ≥15 页 fixture;搜索定位到页 |
| D6 | **P4 一页纸样张**:用现有 fixture 数据手工排版;定义主序列选择 + 折叠规则(每指标取点数最多的维度组合为主线,其余降脚注) | C6 | M7 前 | 样张进 docs,作为"3 秒看懂 vs 医学正确碎片化"的调和基准 |
| D7 | **文档边界组装**:split / merge / move-page 接口;S1 输出边界建议(report_no / 页脚 / 表头变化);幂等撞车处理 | C7 | M2 | 6 张连拍混合单据可事后拆分,S3 布局不受影响 |
| D8 | **ADR 合入 checklist**:每条新 ADR 合入时 grep 全仓库枚举 / 代码示例 / roadmap / fixtures 同步 | C9 / A F10 | 即刻生效 | 见 docs/README |
| D9 | **单人导出 bundle 细则**:decisions 的共享词表类/个人相关类逐 decision_type 分类表;bundle schema 进 contracts;manifests 按人过滤回放的实现 | 二轮审核(ADR-045) | M8 前 | 单人导出演练:导出孩子的 bundle,档案完整(含改归进来的文档)且不含他人隐私 |
| D10 | **`_meta/` 快照自动化**:schema/注册表变更时先落 `_meta` 再上线(CI 强制);`_meta/README.md` 与 04 文档同步机制 | 二轮审核(ADR-045) | M0 | 断言:`_meta/schemas/` 含当前 schema_version(99 B8) |
| D11 | **系统级审计落点**:权限授予/撤销、文档删除 → `_index/audit/{YYYY-MM}.jsonl`;M0 的 owner 自动授予可从 journal 推导,显式接受 | m0 spec 审核 #001 | M1 | 授权变更在桶内可追溯 |
| D12 | **凭证生命周期**:JWT 吊销方案(改密码失效旧 token)+ argon2 参数版本标记与迁移路径 | m0 spec 审核 #001 | M1 前 | 改密码后旧 token 失效 |
