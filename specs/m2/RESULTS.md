# M2 验收结果（进行中，未关闭）

最近执行：2026-08-27。当前入口：`pnpm m2:acceptance`。

> 本页只记录真实执行证据。M2 的完成定义仍是 A(42 项)+B(15 项)全绿并记录 C 组质量基线；当前尚未达到，不得据此宣称 M2 已关闭。

## 验收顺序调整

2026-08-27，项目所有者确认“至少 20 份脱敏真实单据”需要时间收集。C1–C9 因此延期，不再阻塞 A/B 工程开发、自动验收与候选发布；它仍是 M2 最终关闭前必须补录的真实质量基线。合成 fixture/cassette 只用于工程正确性，不得替代或冒充 C 组结论。

## 已执行：A/B 第一批候选验收

覆盖矩阵见 [`ACCEPTANCE-COVERAGE.md`](./ACCEPTANCE-COVERAGE.md)。当前 A 组已有 **18/42 个场景自动化**：A1–A8、A9b、A10–A12、A15–A17、A33–A35；B 组按 CHANGES #14 修订后的边界为 **15/15 自动门禁通过**。但 4 个模型盒均为明确标注的 synthetic stub，尚无真实供应商 wire 录制盒，因此这 18 项不能整体标为“正式集成验收通过”。

Stage 1 使用固定 `p23456/d23456–d23458` 合成文档和 4 个 `provenance=synthetic` 的 committed stub，走预签名上传、EXIF 旋正、worker、工件/DB 落库、归人对账与 facility 首次/缓存复用。它能稳定验证业务编排，但不能证明真实供应商 response wire 兼容。实现期间还修复 A2 的 image/text 顺序偏差，并将 A6 升级为 PostgreSQL 全列全文扫描、A15 增加 transport 调用增量断言。

## 已执行：Human-layer replay（A33–A35 / B13 / B15）

隔离环境使用独立 Compose project、bridge 网络、专用端口与临时卷，不清理本机现有开发/部署数据。

- A33：3 份文档归档、2 次 `person_check_ack`、2 次 facility 确认及 1 次 encounter 确认，删库 → migrate → seed → rebuild 后逐字段一致。
- A34：重建前已有模型场景调用；重建期间 AI transport 新增调用为 0，重建后 `ai_job` 为 0。
- A35：连续第二次 rebuild 结果逐字段一致，journal/decisions 行数不增长。
- encounter 决策载荷封存 facility UUID/slug/aliases 快照；旧版缺快照记录保留决策行并进入对账报告，不伪造外键。
- 该段验收：19/19 通过。

## 已执行：代码与契约门禁

| 门禁 | 结果 |
|---|---:|
| tools human replay | 5/5 |
| contracts | 37/37 |
| storage | 12/12 |
| AI | 49/49 |
| API | 37/37 |
| cassette PII 独立扫描 | 4/4 JSON 通过；recorded=0，synthetic=4 |
| 全仓 TypeScript typecheck | 通过 |

cassette 指纹包含模型、prompt SHA-256、派生图 key、页序及规范化请求摘要；预签名 URL 查询串不影响命中。录制写盘前在解码后的 `full_text` 上按 UTF-16 偏移等长 `*` 遮蔽，姓名/机构替换为 `P1`/`F1`，随后再跑独立手机号/身份证正则。录制器新生成的盒会标记 `provenance=recorded`；现有手工盒标记为 `synthetic`，不再混称为真实录制基准。

## 尚未完成

1. A 组尚余 24 项未完成场景自动化；已自动化的模型相关第一批还缺至少一个真实 wire cassette 复核，不能折算为正式 18/42。
2. C1–C9 已按项目所有者决定延期：`fixtures/m2/regression/` 尚无项目所有者提供并确认脱敏的至少 20 份真实单据；该项不阻塞当前 A/B 推进，但仍阻塞 M2 最终关闭。
3. C 组只记录基线，不设置准确率门槛；待数据到位后需记录混淆矩阵、日期/机构/姓名精确率、全文覆盖、置信度校准、token/成本、PII span 召回和缓存命中。

## 当前结论

Human-layer replay（A33–A35）可验收；A/B 第一批 candidate harness 已可重复运行，但真实 wire cassette 前置未完成，暂不验收该批。M2 整体保持“进行中”。下一工程批次是 A12b–A14、A18–A32 的跨层集成；wire cassette 使用合成图即可录制，不依赖 C 组真实单据；C 组在真实脱敏数据到位后单独补跑并记录基线。
