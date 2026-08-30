# P0-P4 Core Implementation Results

更新：2026-08-28  
当前阶段：Core-0/P0–P4 实现、自动验收与代码审查完成；owner/医生人工 gate 待执行，尚不可宣称正式发布验收完成

## 不可升级的结论

- AI 是可选、可替换、可整体不部署的 processing plugin。
- `PROCESSING_MODE=off` 是默认 Core 运行方式。
- Plugin/provider/model/prompt/cassette/真实单据质量不是 Core-0 至 P4 的发布 gate。
- 未确认 suggestion 不进入 effective metadata、core search、trend 或 export。

## 2026-08-28 验收证据

命令：`pnpm core:acceptance`

| 验收面 | 结果 |
|---|---:|
| Core-0/P0–P4 API assertions | 100 passed, 0 failed |
| P0–P4 Playwright desktop/mobile | 47 passed, 0 failed |
| Contracts Vitest | 73 passed, 0 failed |
| API Vitest | 52 passed, 0 failed |
| Web Vitest | 15 passed, 0 failed |
| Medical Vitest | 16 passed, 0 failed |
| Tools/replay/manual-evidence Vitest | 13 passed, 0 failed |
| Dependency boundary | passed |
| Person bundle ZIP integrity/L1 boundary | passed |
| Delete/rebuild equivalence | passed twice |
| Rebuild final projection | 3 people, 2 documents, 2 encounters, 4 context sessions, 16 answers, 2 media, 15 L1 observations, 1 derived observation, 1 concept alias, 3 metric groups/14 items, 5 medications, 4 timeline events, 53 operations, 39 search entries, 0 processing jobs/suggestions |

验收环境显式 unset provider/model/key，`PROCESSING_MODE=off`，只访问隔离 PostgreSQL 和 MinIO。浏览器使用真实 JPEG/PDF 对象，不使用 AI fixture/cassette。

## 已证明的 P0 范围

- 人工 metadata Merge Patch、逐字段 provenance、revision conflict 与 operation replay。
- encounter create/update/archive/restore/link、跨 person 拒绝与 journal/rebuild。
- sampled/reported/encounter/capture/best-available 日期语义、NULL 范围边界、稳定 cursor 和组合筛选。
- 人工 metadata/encounter 关键词检索、历史建议逐字段/批量接受、撤销和 L2 删除后回放。
- search/detail/bundle 跨账户统一 404。
- 图片原件解码、大图查看、PDF 浏览器 fallback/下载、人工 metadata 与 encounter 真实浏览器写入。
- 固定四项桌面/手机导航，采集为全局 FAB，趋势零状态不使用未确认 AI 结果。
- 单人 L1 bundle 不包含他人路径、他人决策、L2 派生层或上传暂存层。

## 已证明的 P1 自动化范围

- 五套版本化模板、hash 校验、女性年龄条件题 snapshot 与新旧版本冻结契约。
- 文档未上传时创建 session、登记后按 client_document_id 幂等绑定，以及 standalone anytime。
- choice/multi_choice/number/text/date/datetime/audio/photo 八类回答、跳过、文字替代录音和条件题。
- 音频/照片 prepare→presign→PUT→finalize 的 person/session/question/MIME/bytes/SHA 完整性与跨人 404。
- same_day pending、Context 自身搜索投影、`maps_to` 不静默修改其他事实。
- context→Observation 与 context→Medication 只有显式确认才写入，operation replay 与两轮删库重建保持等价。
- IndexedDB v2 四个 store、文档未上传占位、session syncing 与 media pending_finalize 恢复、离线刷新后 Blob/草稿恢复。
- 采集后可跳过 CTA、数据页 pending/standalone 入口、文档详情补录入口和账户时区模板解析。
- session/answer/media sidecar、operation ledger、单人 bundle 与两轮删库重建等价；全程无 ASR/AI job。

## 已证明的 P2 自动化范围

- 本地版本化 concept catalog、raw comparator/value 解析、UCUM canonicalization、单位换算、自洽规则和 RCV/derived 纯函数。
- 100 行 Observation 原子 batch、完整原值/日期精度/series 维度、unknown unit/unmapped warning、修正冲突、归档和搜索投影。
- 稳定 origin capture/order/object/logical-page 来源；当前页投影可变，来源身份不变；缺原件和跨 person 均不猜测、不泄漏。
- concept mapping inbox、个人 alias、原子 resolve 和后续同名自动应用；AI 完全关闭时主链可用。
- observation suggestion 逐行/逐字段接受并冻结 plugin/model/prompt/artifact provenance；L2 suggestion 删除后 L1 事实仍可重放。
- eGFR、非 HDL、BMI 确定性派生；输入修订后派生 ID/key 稳定、input revision hash 与值变化；删库后从 L1 重算逐字段相同。
- Web 文档原件/表格并排、报告级继承、TSV/CSV、concept autocomplete、复制/键盘、100 行分块、行级错误、修正/归档/mapping 和历史建议接受。
- IndexedDB v3 Observation 草稿在刷新后恢复；真实 Chromium 通过 UI 提交映射事实，该事实与 operation 随后通过两轮删库重建。

## 已证明的 P3 自动化范围

- 监控组 CRUD、稳定顺序、revision conflict、归档、“三高+”复制为用户自有 L1，以及 operation replay/journal/rebuild。
- 趋势只读取未归档 confirmed/corrected 事实与 deterministic derived；`input_parameter` 和未确认建议被排除。
- qualifier/body site/specimen/method/device/setting/extra dimensions/result kind 通过完整 selector hash 严格分线。
- SI/UCUM 可比单位连接；未知或不可换算单位独立且标不可比；每点保留该报告参考区间。
- RCV 使用固定 `rcv@1`；同日无真实时间不制造先后或 RCV 比较。
- context 只作为中性事实标签叠加，不解释因果；来源可按 current projection 回到正确页并高亮 bbox，缺失时诚实标 unavailable。
- 0 点、1 点、多点、稳定 cursor、固定 `lttb@1` 下采样及重复响应确定性均通过。
- 删除 processing suggestion 后逐点事实、accepted provenance 与来源不变；两轮删库重建逐字段等价。

## 已证明的 P4 自动化范围

- medication batch/correction/archive、处方/执行分组、稳定来源、分页、搜索、context 显式提升与 journal/rebuild。
- timeline event 的精确时间、仅日期、日期未记录分区；不从自由文本推断时间或新医学事实。
- 导出 preview 冻结范围/数量/缺口/原件估算；canonical manifest、固定 renderer/font/content hash 与历史 stale 标记。
- export worker claim/lease/recovery/retry、对象缺失可重生且同一输入字节 hash 不变。
- PDF 拥挤摘要保持一页；PNG 固定 1240×1754，布局越界显式失败，不再静默截断；未展开条目显示剩余计数。
- 每个指标以独立的“最新｜”“变化｜”“来源｜”扫描行呈现，最新值使用主色，来源原件不可用时明确标注；文案层级有单元回归，但是否达到 3 秒仍只由 P4-12 真人 gate 判定。
- owner/editor/viewer 角色矩阵、内部历史和下载；只有 owner 可创建/查看/撤销公开分享。
- 分享 token 为 256-bit 随机值且只在首次响应显示；服务端只保存 hash，过期/撤销/未知统一 404，公开响应 `no-store`，并按 token hash/IP 限流。
- 真实 Chromium 覆盖桌面和手机的数据事实、导出 preview/progress/download、风险确认、一次 token、公开下载、撤销与 viewer 只读路径。

## 已准备但尚未执行的人工验收包

- `pnpm core:review-sample` 使用正式 renderer/font 生成合成 PDF/PNG；连续两次 SHA-256 相同。
- 合成 PDF 为 1 页；PNG 为 1240×1754 单页。canonical manifest、font/renderer provenance 与内容 hash 一并保存于 `evidence/`。
- `MANUAL-ACCEPTANCE.md` 统一定义 owner、真机、操作耗时、医生可读性与日志脱敏流程。
- `manual-evidence.template.json` 与 `pnpm core:manual-evidence -- <report>` 对所有人工 gate、严格阈值、证据引用、3–5 名医生及真实脱敏样本 fail closed。
- 合成样张只用于预演；不会被校验器接受为 P4-12 正式证据。

## 尚未证明/不得宣称完成

- P0-11：项目所有者/目标用户用已知样例“找到旧文档 <60 秒”。
- P0 Web owner 桌面/手机主观预览与逐字段冲突合并人工检查。
- Person bundle 已验证 ZIP 完整性与 L1 边界；当前删库恢复证据来自同一 L1 对象集，尚未提供“直接导入 ZIP”产品功能。
- P1-6：麦克风权限拒绝后的文字降级已有实现与浏览器文字路径证据，仍待手机实机拒绝权限检查。
- P1-10：项目所有者/目标用户“拍摄+3 点选+2 文字/语音入口 <90 秒”现场 gate。
- P2-10：owner/目标用户 10 行桌面 ≤3 分钟、移动 ≤5 分钟，以及主观桌面/手机预览尚未执行。
- P3 自动化范围已完成，仍待 owner 主观桌面/手机预览。
- P4-11：owner 从 preview 到下载的现场用户操作是否 ≤30 秒，以及实际 PDF/PNG 内容核对尚未执行。
- P4-12：3–5 名医生使用脱敏样例的“3 秒定位”可读性 gate 尚未执行；这是 P4 发布硬门槛。
- 实际部署访问日志尚需抽查确认不包含 share token、person 名称或原文件名。

## 发布状态

上述 Core-0/P0–P4 实现仍在本地工作树，尚未提交、合并或发布。`main`/`origin/main` 仍为 `e697094`。20 份脱敏真实单据继续只属于 AI plugin/现场质量基线，不是 Core 发布 gate。
