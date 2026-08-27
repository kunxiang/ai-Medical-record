# M2 Implementation Review #005 · Acceptance harness 第一批

日期：2026-08-27。范围：Stage 1 candidate harness、cassette、B1/B2 门禁、A6/A15 判别性、重建与 PII 边界。

## 初审结论：REJECT

独立审查确认“`A=18/42 集成通过、B=15/15`”超出证据：

1. B1 门禁对白名单的放宽未同步规范；Zod 3 schema 又无法直接交给 SDK 的 Zod 4 helper。
2. B2 只扫描 `claude-*`，没有覆盖已由项目所有者指定的 DeepSeek 默认模型与 `AI_MODEL` provider 边界。
3. 4 个 committed cassette 的 response ID/model 均为手工 synthetic stub，不是 `AMR_AI_RECORD=1` 得到的真实 wire response。
4. A6 只查名为 `full_text` 的列，不能发现全文藏入 JSON/错误列；A15 没有调用计数，无法证明首次确实调用 AI。
5. `invalid_output` 没有按规范在同一次取件内同步重试一次。
6. 验收使用固定 `/tmp` 文件、固定 Compose project/host 端口；prompt 故障注入直接改 tracked 文件。

## 修复与裁决

- `CHANGES #14` 正式同步已获得项目所有者确认的 DeepSeek provider，并说明 Zod 3 → JSON Schema 的兼容层；B1/B2 门禁按新规范重写，模型覆盖还校验 provider 前缀。
- cassette 新增 `provenance=recorded|synthetic`。录制器只会写 `recorded`；现有四盒全部如实标为 `synthetic`，扫描输出 provenance 计数。
- A6 对 public schema 全部数据库列逐列扫描工件 `full_text`；A15 比较 facility tick 前后 transport 调用数。
- S1 图片/PDF 的 `invalid_output` 同步重试恰一次，并新增成功恢复与连续失败测试。
- M2 runner 使用每次唯一 Compose project、Docker 动态 PG/MinIO host 端口、临时 API 端口与 `mktemp -d` 快照目录；prompt 故障注入只修改临时副本。
- 修正 image-then-text 页号描述、S1 artifact key、A34 调用计数文字及所有“第一批已验收”声明。

## 复审结论：有条件通过（candidate harness）

完整性：18/42 个 A 场景已自动化，剩余 A 项仍在账本；C1–C9 经项目所有者确认延期。真实 wire cassette 与 C 组是两个独立门槛。

正确性：上述判别性和重试缺陷已修复。`pnpm m2:acceptance` 在隔离环境通过：脚本 24/24、contracts 37/37、storage 12/12、AI 49/49、API 37/37、tools 5/5、B1/B2/B10、全仓 typecheck 与 PII 扫描均通过。

一致性：规范、`CHANGES`、覆盖矩阵、RESULTS、roadmap 与 wiki 已同步；扫描明确报告 `recorded=0，synthetic=4`。

最终裁决：candidate harness 可以继续作为开发门禁；**第一批正式验收仍被至少一个真实供应商 wire cassette 阻塞**。录制可使用不含真实 PII 的合成图片，不需要等待 20 份真实单据。
