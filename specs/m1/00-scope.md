# M1 Spec · 00 范围(审核 #002 修订版)

> 里程碑目标(09):**拍照 → 入库,弱网可用。**
> 验收句:飞行模式下拍 5 张 → 恢复网络 → 全部上传成功,一张不丢。
> 依据:01 §离线优先、04 §derived、05 §1/§2、07 §3、ADR-041、ADR-045、**新增 ADR-046/047**。
> 审核记录:[review-002.md](./review-002.md)(31 项 A 档裁决)。

## 1. 交付物

| # | 交付物 | 规范 |
|---|---|---|
| 1 | contracts 增量 + **M0 契约修订 4 项** | [01-contracts-delta.md](./01-contracts-delta.md) |
| 2 | API 增量(列表、派生物、discard、**CORS**、**D11 审计**、**D12 吊销**) | [02-api-delta.md](./02-api-delta.md) |
| 3 | 派生物生成(L2) | [03-derivatives.md](./03-derivatives.md) |
| 4 | 离线队列(IndexedDB + 前台驱动) | [04-offline-queue.md](./04-offline-queue.md) |
| 5 | PWA(家庭成员建档、采集、归人、浏览) | [05-web-app.md](./05-web-app.md) |
| 6 | 验收(含测试注入面与 fixture 生成) | [99-acceptance.md](./99-acceptance.md) |

## 2. 明确不做(M1 边界)

- **无任何 AI 调用**(M2):`doc_type` 恒 `unknown`,无 facility/日期识别、无归人对账。
- **无情境问答**(M3);队列项 `context` 字段位预留,恒 null。
- **无提取/observation/趋势**(M4+);**无检索**(M4);**无 encounter API**(M2)。
- **★ 无软删除**(改判至 M2,审核 #002 S1):它不在 09 的 M1 清单内,却拖进 `archived_at` 列、迁移、journal 新事件、rebuild 回放与 D11 耦合,而 M1 验收句不需要它。M2 与归人纠正(D15)、文档拆分(D7)同批做更自洽 —— 三者共享"事后修改已归档文档"的语义。
- **无后台任务队列**(M2):缩略图按 [03](./03-derivatives.md) 惰性生成。
- **无批量导入**(M2);**无归人纠正**(M2,D15);**无分片续传**(M2,D14);**无 PDF 缩略图**(M4,D13)。
- **无离线浏览**已上传文档(边界声明,非偏差;M4 检索时统一处理)。

## 3. 到期设计债(必须在 M1 内清偿,审核 #002 S2)

| 债 | 绑定 | M1 的清偿方式 |
|---|---|---|
| **D11** 系统级审计落点 | M1 | 收窄为**权限授予/撤销** → `_index/audit/{YYYY-MM}.jsonl`(文档删除部分随软删除一并移交 M2)。见 [02](./02-api-delta.md) §5 |
| **D12** 凭证生命周期 | M1 前 | `account.token_epoch` + JWT `ep` claim;改密码递增即失效旧 token。见 [02](./02-api-delta.md) §6 |

> 二者按 design-debt 表头"到期未清不得进入下一里程碑"必须在 M1 关闭前勾销。M1 恰是第一次把 30 天不可吊销的 token 放进浏览器 localStorage —— 风险敞口在 M1 打开,偿还不能推到风险之后。

## 4. 承接 M0 的既有约束

1. 上传链三步与幂等语义按 m0-06,**但幂等比对口径在 M1 修正**(审核 #002 A-1,见 [01](./01-contracts-delta.md) §5)。
2. 归人:拍摄时本地手选(ADR-041),`confirmed_by='capture_ui'` 必须如实落 L1。
3. 人工输入随写随双写 journal(ADR-045/D1)。
4. 派生物属 `derived/**`:严禁上锁、打包可丢、备份不带。
5. 新增写入 S3 的对象类型必须先在 04 §1 矩阵登记。

## 5. 偏差登记(全部须回写)

| # | 偏差 | 回写目标 |
|---|---|---|
| 1 | Service Worker 后台重试 → **前台驱动**(iOS 无 Background Sync) | **ADR-046(新)** + ADR-013 ⚠️ + docs/01 §离线优先流程图 + docs/05 + 09 |
| 2 | 客户端 EXIF 方向校正 → **原件字节零改动**(04 §6 自相矛盾) | docs/04 §画质规则 + docs/05 §6 |
| 3 | 缩略图生成时机 → **惰性同步生成** | docs/04 §6 + docs/07 §9 + docs/02 §1(jobs 目录) |
| 4 | 07 §3 五个筛选参数 M1 不实现;`from/to` 语义由 `sampled_on` → `capture_date` | docs/07 §3 + 登记语义迁移(随 D15) |
| 5 | 软删除移出 M1 | docs/09(M1/M2 清单) |
| 6 | 分片 + 断点续传未实现 | docs/01 §离线优先 + **D14** |
| 7 | `page_no` = 拍摄顺序(M1 无页脚解析) | **ADR-047(新)** + ADR-025 ⚠️ |
| 8 | 新增 `POST /captures/discard` 与 415/422 两个状态码 | docs/07 §2 接口清单 + §8 错误码表 |
| 9 | journal 新增 `capture_discard` 事件 | docs/04 §3 事件清单 + `_meta/README` + registries |

## 6. M1 的验收哲学

1. **一张不丢**:飞行模式拍 5 张 → 恢复网络 → 5 份文档、5 个原件、sha256 与**注入 fixture 的已知值**逐一相等、5 条 manifest add 行。
2. **不重复**:同一队列项无论重试多少次、跨多少次重启与重新 presign,服务端只产生一份文档。
3. **L1 零字节变动**:A 组全程(上传完成后 → A 组结束)`people/**` 的 `(Key, VersionId, ETag)` 全量清单逐字节相同;删光 `derived/**` 后浏览仍可用。
