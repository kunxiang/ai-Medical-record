# Design Review 002 · P0-P4 Core

日期：2026-08-28  
结论：**PASS — 允许进入编码**

## 审查范围

- 独立 Tech reviewer：PASS。
- 独立 UX/Biz reviewer：PASS。
- Consistency：`01_design_spec.md`、`02_api_contracts.md`、`03_database.md`、`04_acceptance.md`、`05_ux_states.md` 与原始设计/现有 L1 恢复约束交叉检查。
- MCP-LSP 未暴露；使用 `rg`、定点源码阅读和 `git diff --check` fallback。

## Review 001 blocker 关闭

1. 离线/standalone context、模板缓存、client document bind 与媒体完整性闭合。
2. 确定性 concept catalog、person alias、mapping inbox resolve 与趋势入口闭合。
3. suggestion 实体、逐字段 provenance、legacy migration 与 L1 接受快照闭合。
4. observation 完整字段、日期精度、origin/order/logical-page 来源与派生依赖闭合。
5. medication/timeline_event 事实、canonical time 和 P4 时间轴闭合。
6. revision、operation ledger、删库后 operation replay 和冲突 UI 闭合。
7. export claim/lease/retry、renderer/font/input provenance、stale 与分享安全闭合。
8. 旧 family AI job 原位 drain；新 queue 冻结 target plugin version。
9. search projection、通用 result、日期筛选与稳定 cursor/index 闭合。
10. 四项移动导航、量化人工成本、状态/权限矩阵闭合。

## 非阻塞的实现后验证

- 10 行人工录入真机耗时。
- 3–5 名医生的“3 秒定位”脱敏样例验证。
- 用户收集的 20 份真实脱敏单据可继续延期；它属于插件质量/后续 field validation，不是 Core-0 至 P3 编码 gate。

## 许可

规格足以指导 Fastify/Zod/Drizzle/React 实现。编码必须按 Core-0→P0→P1→P2→P3→P4 分层推进，每层同时交付 migration、contracts、API、Web、journal/rebuild 和验收；不得把恢复留到最后补做。
