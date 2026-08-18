# M1 Spec · 00 范围

> 里程碑目标(09):**拍照 → 入库,弱网可用。**
> 验收句:飞行模式下拍 5 张 → 恢复网络 → 全部上传成功,一张不丢。
> 依据:01 §离线优先、04 §derived、05 §1/§2/§离线队列、07 §3、ADR-041(本地归人)、ADR-045(L1/L2 分层)。

## 1. 交付物

| # | 交付物 | 规范 |
|---|---|---|
| 1 | contracts 增量(列表/缩略图/队列事件) | [01-contracts-delta.md](./01-contracts-delta.md) |
| 2 | API 增量(GET /documents、缩略图、软删除) | [02-api-delta.md](./02-api-delta.md) |
| 3 | 派生物生成(缩略图/预览图,L2) | [03-derivatives.md](./03-derivatives.md) |
| 4 | 离线队列(IndexedDB + Service Worker) | [04-offline-queue.md](./04-offline-queue.md) |
| 5 | PWA(采集、归人选择、浏览) | [05-web-app.md](./05-web-app.md) |
| 6 | 验收 | [99-acceptance.md](./99-acceptance.md) |

## 2. 明确不做(M1 边界)

- **无任何 AI 调用**(M2):`doc_type` 恒 `unknown`,无 facility/日期识别、无归人对账、无 `person_mismatch`。
- **无情境问答**(M3):队列条目**预留** `context` 字段位但 M1 不写入、不上传。
- **无提取/observation/趋势**(M4+)。
- **无 encounter API 与归组**(M2):浏览按 `capture_date` 分组,不按就诊。
- **无后台任务队列**(M2):缩略图按 [03](./03-derivatives.md) 的**惰性生成**策略,不建 job 表。
- **无检索**(M4):浏览只有按人 + 时间轴 + 分页,无关键词。
- **无批量导入**(M2):`needs_person_confirm` 仍不可达。
- **无归人纠正**(M2):`correction-NNNN.json` 仍无写入路径。
- **无 PDF 缩略图渲染**:PDF 页在 UI 显示类型占位图([03](./03-derivatives.md) §4,标注偏差)。

## 3. 承接 M0 的既有约束(不得偏离)

1. 上传链三步与幂等语义按 [m0-06](../m0/06-api-m0.md),客户端**不得**新增或改写服务端契约。
2. 归人:拍摄时本地手选,`person_confirmed: true`(ADR-041);**离线可用,不依赖任何网络调用**。
3. 一切人工输入随写随双写 journal(ADR-045/D1)—— M1 新增的人工输入见 [01](./01-contracts-delta.md) §4。
4. 缩略图属 `derived/**`:**严禁上锁**、打包可丢、备份不带(04 §1 权威矩阵)。
5. 新增写入 S3 的对象类型必须先在 04 §1 矩阵登记。

## 4. M1 的验收哲学

M1 交付的是**采集侧的可信度**。验收最重的三条:

1. **一张不丢**:飞行模式拍 5 张 → 恢复网络 → 5 份文档、5 个原件、5 条 manifest add 行,且 sha256 全部匹配。
2. **不重复**:同一条队列项无论重试多少次、跨多少次应用重启,服务端只产生一份文档(幂等键在**拍摄时**生成并持久化)。
3. **L2 可丢**:删光 `derived/**` 后浏览仍可用(缩略图重新生成),且 L1 一个字节未变。
