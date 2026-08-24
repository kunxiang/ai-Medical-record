---
title: "AI 病历工程知识索引"
kind: engineering-index
status: active
scope: repository
verified_on: 2026-08-24
owners: ["ai-medical-record"]
---

# 工程知识索引

`agent_wiki/` 只保存经代码、测试或当前规范验证的工程知识；会话交接、临时发现和仍会变化的实现状态放在 `runtime/`。用户可见行为与操作流程放在 [`feature_wiki/`](../feature_wiki/README.md)。

## Durable knowledge

- [架构、数据分层与安全边界](./architecture-data-and-security.md)：仓库依赖方向、L1/L2/L3 边界、鉴权和部署约束。

## Runtime knowledge

- [M2 实现状态与恢复锚点](./runtime/m2-implementation-status.md)：当前已实现、未实现、下一步和验收缺口。

## 查询与维护约定

1. 优先级固定为：当前代码与测试 → 当前 spec → durable wiki → runtime wiki → 推断。
2. durable 页面只写可复用规则，不保存会话流水、一次性日志、密钥或未验证猜测。
3. 用户界面、工作流、权限或运维行为变化时同步更新 `feature_wiki/`。
4. 架构约束变化必须先更新设计文档或 ADR，再更新本目录；wiki 不成为第四份相互冲突的真相。
5. 恢复任务时先读相关 durable 页面，再读 `runtime/`；实施或评审前仍须直接复核代码和 spec。

## 当前来源基线

- Git commit：`1c8fbba8b04da0336c9b2fae241afd712e55f302`
- 来源选择与哈希：[context manifest](../docs/context-manifest.yaml)
- 本索引初始化日期：2026-08-24
