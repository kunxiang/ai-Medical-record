# Acceptance · P0-P4 Core and Plugin Independence

## 0. Gate 原则

- Core gate 证明无 AI 也完整可用，是 P0–P4 required check。
- Plugin qualification 只决定 adapter rollout；失败最多让 `PROCESSING_MODE=off`。
- Core 验收显式 unset 全部 provider/model/key，禁止供应商 egress，但允许部署内 PostgreSQL/S3。
- `pnpm core:acceptance` 不得 import AI fixtures/cassettes；`pnpm plugin:acceptance --plugin=<id>` 可使用它们。

## 1. Core-0

| ID | 场景 | 断言 |
|---|---|---|
| C0-1 | 无 AI 启动 | API/Web/DB/S3 健康；Core 镜像不加载 provider SDK |
| C0-2 | off 文档登记 | document ready，旧/新处理 job 均不新增，无错误横幅 |
| C0-3 | assist 故障 | 文档仍 ready；仅辅助面板显示错误；backfill 可恢复调度 |
| C0-4 | capability | off、心跳有效、90 秒过期及 capability 请求失败均 fail closed |
| C0-5 | L2 清空 | 删除 job/suggestion/search/trend/export/AI 工件后 L1 不变，可重建 |
| C0-6 | 依赖边界 | core contracts/API 无 vendor SDK import，plugin worker 可不部署 |
| C0-7 | 旧队列 drain | family job 不伪造 person；旧队列不收新任务；confirmed decision 可回放 |
| C0-8 | 新队列 rerun | input revision/plugin version 变化可新建 job，重复 backfill 不重复 |
| C0-9 | 通用幂等 | L1 mutation 删库前后重放同 operation 返回安全首次快照；异 payload 409；L2/share 例外符合契约 |
| C0-10 | CI 门禁 | M2/plugin qualification 失败不阻塞 core required check |

## 2. P0

| ID | 场景 | 断言 |
|---|---|---|
| P0-1 | 人工元数据 | Merge Patch null/omit 正确；逐字段 source/provenance/revision 正确 |
| P0-2 | 幂等/并发 | 同 op 同 payload 幂等、异 payload 409；stale revision 返回 base/current/draft |
| P0-3 | 列表三层组织 | sampled/reported/encounter/capture/best-available 五种日期分别验收 NULL、范围、排序和 cursor；其他筛选与 encounter 分组正确 |
| P0-4 | 手工 encounter | CRUD/link/跨 person 拒绝/journal/rebuild 完整 |
| P0-5 | legacy inbox | 未确认旧值显示为建议；字段 diff、50 条批量确认、冲突与撤销可用 |
| P0-6 | 历史建议关闭插件 | off 后历史建议仍可看/接受；不生成新建议 |
| P0-7 | 关键词检索 | metadata/filename/encounter/context/observation/medication/timeline event 均可命中，无 document 的事实可表示 |
| P0-8 | 搜索权限/游标 | 无权不泄漏；同 sort key 稳定翻页；L2 index 清空可重建 |
| P0-9 | 图片/PDF 详情 | 原件可放大/分页/下载；无缩略图时有诚实 fallback，不显示“即将支持” |
| P0-10 | bundle | 只含目标 person 的 L1、过滤 manifest/decisions/_meta；空库恢复零丢失 |
| P0-11 | 找旧文档 | 目标用户用已知样例 <60 秒完成定位 |

## 3. P1

| ID | 场景 | 断言 |
|---|---|---|
| P1-1 | 离线即时/standalone session | document scope 仅 client_document_id 可建本地 session并后绑定；standalone anytime 可 create/rebuild 且不伪造文档 |
| P1-2 | 三种恢复态 | 未上传文档、未同步 session、媒体待上传重启后均不丢草稿 |
| P1-3 | 模板版本 | 本地缓存 hash 校验；新旧版本并存；既有问题/条件/timeline_kind 不漂移 |
| P1-4 | 全答案类型 | choice/multi/number/text/date/datetime/audio/photo 保存、跳过和回放 |
| P1-5 | 媒体完整性 | prepare/finalize 校验 person/session/question/MIME/bytes/SHA；他人 key 与替换对象拒绝 |
| P1-6 | 无 ASR | 原音频可播放；transcript 可空且无失败态；麦克风拒绝可改文字 |
| P1-7 | pending/条件题 | 当天补录仅返回有权会话；条件题显隐确定性且刷新一致 |
| P1-8 | context 不越权 | maps_to 不静默写其他事实；promote 有预览和显式确认 |
| P1-9 | journal/rebuild | session、绑定、问题 snapshot、answer、媒体 sidecar、completion 可恢复 |
| P1-10 | 现场耗时 | 拍摄+3 个点选+2 个文字/语音入口 <90 秒，全部可跳过 |

## 4. P2

| ID | 场景 | 断言 |
|---|---|---|
| P2-1 | 100 行原子批量 | 第 N 行错误返回路径且整批 0 写入；>100 行 UI 自动分块 |
| P2-2 | 完整原值 | comparator/text/dimensions/qualifier/body site/extra dims/ref/flag/specimen/method/device/result kind 均不丢 |
| P2-3 | 时间精度 | 只有日期时保存 observed_on + date precision，不伪造午夜；继承来源明确 |
| P2-4 | 确定性解析/换算 | `<3.62`、unit、UCUM 固定输入固定输出；未知单位保存并告警 |
| P2-5 | concept 无 AI 主链 | catalog/alias/inbox 可用；resolve 原子更新既有行，成功后立即可加入监控组并可 rebuild |
| P2-6 | 修正冲突 | correction note、before/after、revision conflict merge 均正确；插件重跑不覆盖 |
| P2-7 | suggestion 接受 | 稳定 suggestion id；逐行/逐字段接受；删 L2 后 accepted fact 可回放 |
| P2-8 | 稳定来源 | 重复 SHA、多页对象、split/merge/move 后按 origin/order/logical index 回到正确页；跨 person 拒绝 |
| P2-9 | 派生重建 | dependency IDs/revision hash/formula/version 固定；删 DB 后重算相同 |
| P2-10 | 手工录入效率 | 10 行桌面 ≤3 分钟、移动 ≤5 分钟；每行重复字段 ≤2 次；草稿恢复 |
| P2-11 | source 缺失 | 原件缺失时事实保留并标 source unavailable，不跨文档猜测 |

## 5. P3

| ID | 场景 | 断言 |
|---|---|---|
| P3-1 | 监控组 | CRUD/archive/顺序/“三高+”复制后 journal/rebuild 完整 |
| P3-2 | 趋势过滤 | 只含未归档 confirmed/corrected facts；input_parameter 排除 |
| P3-3 | series 边界 | qualifier/body site/specimen/method/device/setting/extra dims/result kind 不错误合线 |
| P3-4 | 参考区间 | 每点保留该报告 ref，不用全局值；不可换算单位不硬连线 |
| P3-5 | RCV | 固定版本纯函数；数据不足或不可比返回 null |
| P3-6 | 同日精度 | 无时刻点不伪造先后；有时刻 medication/context 可对齐 |
| P3-7 | 情境叠加 | 只显示事实标签，不解释因果 |
| P3-8 | 来源回链 | bbox 高亮；无 bbox 按 origin/order/logical index 打开正确页；缺原件诚实标注 |
| P3-9 | 0/1/大数据 | 0 点录入 CTA、1 点无趋势提示；分页/固定下采样稳定且可导出全量 |
| P3-10 | AI 清空 | 删除插件数据后趋势逐点和来源不变 |

## 6. P4

| ID | 场景 | 断言 |
|---|---|---|
| P4-1 | medication | prescribed/administered、分组、剂量、时间、来源人工 CRUD/journal/rebuild 完整 |
| P4-2 | 时间轴事实 | 各来源 canonical date/范围/undated/同日排序固定且可追源，无自由文本猜测 |
| P4-3 | 预览 | 生成前显示范围、缺口、数量、原件大小/页数估算和风险 |
| P4-4 | 一页纸 | 首屏包含 person、范围、最新值/变化/来源和关键事件；无医学结论 |
| P4-5 | 确定性 | 同 canonical 输入、renderer/font 生成相同 content hash，metadata 记录版本 |
| P4-6 | 可恢复队列 | claim/lease/retry/僵尸回收；worker 崩溃不永久 running |
| P4-7 | 对象重生/stale | 删除结果可按原请求重建；数据变化后旧导出标 stale，不静默更新 |
| P4-8 | 原件附录边界 | 只附目标 person；超限返回估算/建议，不静默截断；缺原件列 gap |
| P4-9 | 权限 | viewer 可从 person 历史发现/下载完成项，editor 可生成，仅 owner 公开分享；无权统一 404 |
| P4-10 | 分享安全 | 256-bit token 仅首次返回；同 op 重试不返回 token；hash only、5m..7d、撤销/过期统一 404、no-store、限流、日志脱敏 |
| P4-11 | 操作耗时 | 有数据时 preview→生成→下载的用户操作 ≤30 秒（后台渲染时间另记） |
| P4-12 | 医生可读性 | 3–5 名医生用脱敏样例完成“3 秒定位最新值、变化、来源”；真实样本收集可延期但发布前执行 |

## 7. 全局 UX 状态和安全

`05_ux_states.md` 每一行必须有组件测试或 E2E：core capability 请求失败、离线模板缺失、麦克风拒绝、PDF fallback、批量行错误、趋势空态/不可比、来源缺失、大导出、retry/stale、分享权限。移动底栏不得超过 4 项，采集路径 ≤10 秒且归人仍为唯一强制确认。

## 8. Plugin qualification

| ID | 场景 | 断言 |
|---|---|---|
| Q-1 | adapter 切换 | core contract 不变，建议记录完整 plugin/model/prompt provenance |
| Q-2 | suggestion 隔离 | 未接受建议不进入 metadata/observation/trend/export/search core corpus |
| Q-3 | 禁用/故障 | 不创建新 job；core UI/L1 不变；历史建议仍可访问 |
| Q-4 | provider wire/schema | cassette、重试、invalid output、模型约束只影响 plugin rollout |
| Q-5 | PII/成本/质量 | 独立报告，不参与 core required status |

现有 `pnpm m2:acceptance` 的全绿只能说明现有 harness 通过。B1/B2、真实 cassette、A6/A15 等证据修复前，不得继续声称 `A=18/42,B=15/15`；该问题不阻塞 Core-0/P0。

## 9. 分阶段 gate

| 阶段 | 必须通过 | 可延期 |
|---|---|---|
| Core-0 | C0-1..10 | provider wire、真实单据、模型质量 |
| P0 | Core-0 + P0-1..11 | OCR/semantic |
| P1 | 上一阶段 + P1-1..10 | ASR/AI 追问 |
| P2 | 上一阶段 + P2-1..11 | 视觉提取准确率 |
| P3 | 上一阶段 + P3-1..10 | AI 解读 |
| P4 | 上一阶段 + P4-1..12 | 任意 provider 可用性；P4-12 真实样本验证必须在 P4 发布前完成 |
