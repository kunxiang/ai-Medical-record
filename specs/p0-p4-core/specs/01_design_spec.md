# Design Spec · P0-P4 非 AI 核心主线与可插拔智能处理

状态：第二轮审查候选  
日期：2026-08-28  
任务：`p0-p4-core`

## 1. 不可协商的产品边界

1. P0–P4 每项价值必须在无模型、无密钥、无供应商网络、无 plugin worker 时端到端完成。
2. AI 只产生 suggestion、OCR、ASR、embedding 或排版建议；AI 输出不是事实，也不能自行晋升为事实。
3. 人工录入、人工修正、导入以及“接受建议”是 L1；趋势和导出只消费这些事实与确定性派生。
4. Core acceptance 是发布 gate；Plugin qualification 只决定某个 adapter 能否启用或默认开启。
5. 不诊断、不给治疗/用药建议、不用全局正常值覆盖报告自带参考区间。

现有 M2 实现保留，但移动到插件资格轨。真实 wire cassette、模型质量和真实单据样本不再阻塞 P0–P4 核心开发与发布。

## 2. P0–P4 完成定义

### P0 · 归档 DMS

无 AI 时可上传/查看图片与 PDF，人工维护文档类型、采样/报告日期、机构、科室、标题、备注，按人→就诊→文档组织和筛选，检索人工资料，编辑就诊，并导出单人完整 L1 bundle。

### P1 · 情境记录

拍摄完成后可离线立即回答版本化模板；支持 choice、multi-choice、number、text、date、datetime、audio、photo，全部可跳过、暂停、续答和当天补录。音频/照片是 L1 原件；ASR 与 AI 追问可完全关闭。

### P2 · 结构化数据

可在原件旁批量录入 observation，保留原值、时间精度、比较符、定性/多维值、参考区间、标本、方法、设备、测量情境和稳定来源页。概念搜索、单位解析、换算、派生和自洽校验均为确定性代码。AI 只形成待接受建议。

### P3 · 指标监控与趋势

用户可把已映射事实加入监控组，按完整 series identity 展示趋势、报告参考区间、RCV、情境标注和来源回链。未映射行进入人工整理队列，不会成为死数据，也不会错误合线。

### P4 · 就诊导出

确定性生成一页纸趋势、就诊/用药/情境时间轴、来源标记和可选原件附录，支持 PDF/图片、预览、下载、限时分享和数据更新后的 stale 标识；不包含 AI 医学结论。

## 3. Core 与智能插件边界

### 3.1 运行模式

```text
PROCESSING_MODE=off|assist   # default: off
```

- `off`：Core 不导入 provider adapter、不启动 worker、不创建处理 job、不访问供应商网络。
- `assist`：独立 plugin worker 加载 adapter，通过通用队列工作。
- AI provider/model/key 只在 plugin worker 内读取；Core API 镜像不需要供应商 SDK。
- “无外网”是指禁止供应商/公共互联网 egress；PostgreSQL、S3 等部署内核心依赖仍可访问。

### 3.2 窄端口与进程

Core contracts 只定义 capability、job envelope、suggestion envelope，不依赖 `packages/ai`：

```ts
type ProcessingCapability =
  | 'document_metadata_suggest'
  | 'facility_suggest'
  | 'encounter_suggest'
  | 'transcribe_audio'
  | 'observation_suggest'
  | 'semantic_embed';
```

- Plugin worker 用 `processing_plugin` 心跳声明 id/version/capabilities。
- Core 文档登记独立提交；assist 调度失败不回滚文档、不改变核心状态。
- durable backfill 按输入 revision/fingerprint 补发缺失任务；同一插件新版本可显式 rerun。
- 插件错误只出现在“智能辅助”区域。

### 3.3 旧队列迁移

不把旧 `ai_job` 强行转换为新队列。兼容发布步骤：

1. 停止向旧队列投递新 job；旧 worker 原位 drain。
2. 家庭级 `facility_normalize` 等无法无损映射的行完成、失败归档或由新 backfill 重建，不伪造 `person_id`。
3. 已确认 `normalization_decision` 继续作为 L1 人工事实回放。
4. 确认旧队列无运行任务后，另行迁移删除；Core-0 不以删除旧表为前置。

## 4. 事实、建议、来源和版本

### 4.1 元数据有效值

有效值逐字段计算：

```text
manual > accepted_suggestion > capture_fallback
```

未确认 suggestion 只在建议面板显示，永不进入 effective metadata。`document_manual_metadata.field_provenance` 为每个字段保存 `{source,event_id,suggestion_id?}`，journal 保存值与 provenance 的完整快照。

旧 Stage 1 值进入“迁移收件箱”，支持逐字段 diff、单条/批量接受。批量操作仍逐文档逐字段写 L1 事件。撤销通过新 revision 将字段清空或改为人工值，不篡改历史。插件关闭不隐藏历史建议。

### 4.2 suggestion 实体

未确认建议是可删除 L2：数据库 `processing_suggestion` 保存稳定 ID、字段快照、subject、plugin/model/prompt/artifact provenance 和状态，原始大工件可在 S3。接受时把所选字段快照与 provenance 复制到 L1 事件；因此 L2 删除后事实可重建。

### 4.3 统一并发与幂等

- 所有可编辑 L1 投影有整数 `revision`，创建后为 1，每次有效修改 +1。
- PATCH/归档/完成请求必须带 `if_revision`；不匹配返回 409 `{base_revision,current,draft}`。
- 所有人工写请求带稳定 `client_operation_id`。L1 fact event 同时保存 `request_hash` 和不含 URL/token 的安全 response snapshot；rebuild 据此恢复幂等 ledger，所以删库前后重放语义一致。
- 通用 `operation_ledger` 以 `(account_id, client_operation_id)` 唯一，并保存 `subject_type/subject_id/request_hash/result`；同 ID 异 payload 返回 409。导出 job 等 L2 mutation 只保证 ledger 保留期内幂等。
- IndexedDB 保存 operation ID 与草稿直到服务器确认。

## 5. 核心数据流

### 5.1 文档、详情与搜索

```text
上传原件 → capture/page sidecar → document ready → 可立即人工整理
                                            └─ assist 时可恢复地调度 suggestion
```

- 文档列表分别返回 sampled/reported/encounter/capture 四种日期与来源；筛选显式选择日期语义，默认 best-available 规则固定，可按 encounter/type/facility/department 筛选。
- `search_entry` 是可从 L1 重建的确定性 L2 索引，覆盖 metadata、encounter、context、observation、medication。
- 搜索结果是通用 subject，可无 `document_id`；每个列表冻结 `(sort_key,id)` 游标与对应复合索引。
- OCR/semantic 命中单独标为 assist，不与 core corpus 混淆。

### 5.2 离线情境

Web 缓存模板与问题 snapshot。客户端生成 `context_session.id`，允许只用 `person_id + client_document_id` 离线建立 session；文档登记后按 `client_document_id` 幂等绑定 `document_id`。明确恢复态：

1. 文档未上传；
2. session 尚未同步；
3. 回答已同步但音频/照片待上传。

`maps_to` 不静默修改其他事实。带 `timeline_kind` 的问题答案本身可作为“用户记录的情境/用药变化”事件显示；若要结构化为 medication/observation，UI 提供显式“转为结构化事实”动作并复用答案内容。

### 5.3 安全媒体上传

音频/照片复用 prepare→presign→upload→finalize：upload intent 绑定 person/session/question、MIME、bytes、SHA-256；finalize 校验对象大小、hash、归属和未被使用后，才把 L1 key/sidecar 写入 answer journal。任意对象 key 不能直接提交。

### 5.4 observation 与概念映射

- `observed_on` 必填；`observed_at` 可空；`time_precision=date|minute|unknown`，不制造午夜精度。
- 报告级日期/标本/方法/设备可继承，行可覆盖。
- `packages/medical` 提供版本化本地 concept catalog、UCUM 解析、值/比较符解析、换算、RCV 和自洽规则。
- local name 通过 catalog 搜索或人工 alias decision 映射；未映射行进入整理队列。resolve 操作在同一事务写 alias decision 与所选既有 observation 的新 revision，成功后立即可加入趋势。
- 来源身份使用 `{origin_capture_document_id,origin_capture_order,object_sha256,logical_page_index,source_bbox?}`；`document_id/page_no` 只用于当前导航。capture order 区分重复内容页，logical page index 区分多页对象。split/merge/move 只重算当前投影，不改事实来源。
- series identity 包含 concept、qualifier、body_site、specimen、method、device、measurement_setting、extra_dims、result_kind。
- 派生行保存输入 observation IDs、输入 revision/hash、公式/版本和 derivation key；重建时从输入事实确定性重算。

### 5.5 用药与事件

`medication` 是 L1 人工事实，区分 prescribed/administered，保留原药名、剂量、浓度、频次、途径、分组、执行/起止时间、来源页和 note。P4 事件来源冻结为：

- encounter；
- medication；
- 带稳定 `timeline_kind` 的 context answer；
- `timeline_event` 人工事实（如手术、住院、过敏反应等），可选稳定来源页；不从自由文本猜测。

时间轴 canonical date：encounter=`occurred_on`；administered medication=`administered_at`，prescribed medication=`started_on`；context 由模板 `event_time_source` 确定；timeline event=`occurred_on/occurred_at`。无临床日期的事实进入“日期未记录”分区，不用 created_at 冒充。范围导出默认包含该分区并单独标注；同日只有日期的事件不与精确时刻事件伪造先后。

### 5.6 趋势与导出

- 趋势只读取未归档、confirmed/corrected 的 L1 facts 与确定性派生。
- 同日无时间的点不伪造先后；使用稳定 ID 排序并标注“仅日期”。
- 数据量大时服务端分页并按固定算法下采样，下载仍可取全量 CSV/JSON。
- 导出 worker 复用 claim/lease/retry/僵尸回收模式；请求保存 source revision/hash、renderer/font hash。
- 对象缺失时原 job 可重新入队；数据变更不偷偷改历史导出，而标记 stale 并提示重建。

## 6. 信息架构与人工成本

### 6.1 导航

- 移动底栏：档案、数据、趋势、账户；采集为全局 FAB。
- 桌面主区：档案、数据、趋势、账户；采集为持续可见主按钮。
- 情境是采集完成后的可跳过 CTA，也可从文档详情/数据页补录。
- observation 在文档详情内录入；导出在人物摘要/趋势页发起，不设平级主导航。
- 智能辅助只在设置与文档建议面板出现。

### 6.2 录入效率

- 归人是采集唯一强制确认；回访用户采集仍约两次应用内动作。
- observation 支持表格粘贴、concept autocomplete、值/单位确定性解析、报告级字段继承、复制上一行/整列、键盘移动、草稿恢复和“只录监控指标”。
- 量化 gate：采集 ≤10 秒；采集+5 题 <90 秒；10 行桌面 ≤3 分钟、移动 ≤5 分钟且每行重复字段不超过 2 次；已有数据生成并下载摘要的用户操作 ≤30 秒；找旧文档 <60 秒。

详细状态和权限矩阵见 `05_ux_states.md`。

## 7. 安全与权限

- 全部端点经过 person access；无权限与不存在统一 404。
- editor 可编辑事实并生成导出；viewer 只读和下载已授权内部导出；只有 owner 可创建/撤销公开分享。
- 创建分享前展示 person、日期范围、内容、期限和风险；token 至少 256 bit，只存 hash，5 分钟至 7 天，响应 `private, no-store`，按 token/IP 限流，日志不记录 token/医疗文件名。
- bundle/export 只能包含目标 person；原件缺失时如实列出 gap，绝不跨人补齐。

## 8. L1 恢复契约

每个 journal/decision event 使用严格 Zod schema，至少含 event/version/id/account/client operation/subject revision 和完整 after snapshot。凡引用 facility、page、concept 等外部行，事件携带恢复所需快照或稳定自然键：

- facility 引用携带 facility snapshot；
- page 引用携带 capture id + page SHA-256；
- concept 引用携带 catalog version + concept code/display；
- derived 不进 L1，按 dependency graph 重算。

contracts union、registry、schema snapshot、README、bundle filter 和 rebuild 必须同一提交更新。清空 DB、处理 job、suggestion、search/trend/export 工件后，L1 人工事实可完全恢复，P3/P4 可重新生成。

## 9. 两条验收轨

### Core acceptance（required）

在 `PROCESSING_MODE=off`、无 provider 配置、禁止供应商 egress 下覆盖完整人工主链、权限、离线、媒体完整性、幂等并发、journal/rebuild、确定性计算与导出。不得读取 AI cassette。

### Plugin qualification（optional rollout gate）

覆盖 adapter wire/schema、prompt/cassette、PII、质量/成本、suggestion 隔离和故障降级。当前 M2 acceptance 在证据修复前只能作为 harness 状态，不得宣称 A/B 满分，也不影响 Core。

## 10. 实施与传播顺序

1. Core-0：运行/门禁解耦、capability、旧队列 drain 策略、通用 operation ledger。
2. P0：manual metadata/provenance、详情/PDF、encounter、search projection、legacy inbox、bundle。
3. P1：本地模板/session/草稿、安全媒体上传、同步绑定。
4. P2：concept catalog/alias、完整 observation、稳定来源、manual batch、确定性 medical 包。
5. P3：metric group/trend/RCV/source link。
6. P4：medication/timeline events、preview/export worker/share/stale。

每层都同时交付 migration、API、Web、journal/rebuild 和验收。通过审查后同步 `docs/00,01,03,05,06,07,09,11`、ADR、feature wiki 和 M2 发布语义。

## 11. Out of scope

- 诊断、鉴别诊断、疾病概率、治疗或用药建议。
- AI 自动接受 suggestion 或按置信度静默晋升。
- HIS/LIS、FHIR、DICOM 接入。
- 多人实时协作、邀请系统、医疗机构租户、通用插件市场。
