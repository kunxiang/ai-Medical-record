# P4 Review Evidence

本目录当前只包含由正式 `medireco-visit-summary@1.0.0` renderer 生成的**合成、非临床** PDF/PNG 样张、canonical manifest 与 provenance。

- 它用于 owner 排版预检和医生测试流程排练。
- 它不包含真实人员数据，不能替代 P4-12 的脱敏真实样例。
- 运行 `pnpm core:review-sample` 可确定性重建；hash 见 `provenance.json`。
- 完成人工验收后，将不含 PII 的 `manual-evidence.json` 放在此目录；录屏等敏感证据只保存其受控引用。
