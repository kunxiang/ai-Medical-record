# M2 Spec · 99 验收清单

环境:M1 的 compose(PG16 + MinIO)。入口 `pnpm m2:acceptance` → `infra/run-m2.sh`。

> **M2 的验收分两类,不可混淆**([00](./00-scope.md) §6):
> **A/B 组 = 工程正确性,必须 100% 通过。**
> **C 组 = 提取质量,只测量、只记录基线,不设通过线。** 任何把"准确率 ≥ X%"写成通过条件的实现,视为 A 档偏差。

## 0. 前置:模型调用的隔离

真实调用 Claude API 会让验收变慢、变贵、且**不确定** —— 同一输入两次运行结果可能不同,而 A 组断言的是工程正确性,不是模型输出。因此:

1. **必须**提供 `packages/ai` 的注入点 `setTransport(fn)`,默认是真实 SDK。
2. A/B 组 **必须**用**录制回放** transport:首次以 `AMR_AI_RECORD=1` 真实调用并把请求/响应落 `fixtures/m2/cassettes/{hash}.json`,此后按请求指纹回放。指纹 **必须**包含 `model`、`prompt_sha256`、图像 key 与页序。
3. **禁止** A/B 组断言依赖真实网络。C 组**必须**真实调用(它测的就是模型质量)。
4. 录制盒 **必须**提交进仓库(它们是行为基准,与 fixtures 同等地位),剥除规则如下(审核 #004 A-10 / B-9):
   - 剥除**必须**在**解码后的 `full_text` 字符串**上执行,再重新序列化。**禁止**在原始响应字节上直接套偏移 —— `full_text` 在响应 JSON 里是被转义的子串,直接套会错位裁剪:PII 残留 + JSON 结构破坏。
   - 剥除方式**必须**是**等长遮蔽**(逐字符替换为 `*`),**禁止**删除 —— 删除会改变 `full_text` 长度,使 `pii_spans` 的 UTF-16 偏移全部失效,而那正是 A9 要检验的东西。
   - 保留类 PII(姓名、机构)**必须**替换为占位符(`P1`/`P2`…、`F1`/`F2`…)。
     > 即使丢弃类剥除 100% 成功,提交进仓库的仍是"带真实姓名、真实医院、真实检验结果的完整病历文本",且 ≥20 份。
     > **这条属隐私取舍,项目所有者可以放宽** —— 但要显式写下来,不能默认。
   - 剥除**禁止**依赖模型自报的 `pii_spans` 作为唯一保证:B14 会对录制盒全量跑确定性正则,命中即失败。

## A. 端到端(工程正确性)

| # | 步骤 | 断言 |
|---|---|---|
| A1 | 上传一份带 `Orientation=6` 的单页文档 | `derived/{slug}/{sid}/ai-01.webp` 存在;其像素**高 > 宽**(已旋正);长边 ≤ 2576;`sharp().metadata().exif` 为空 |
| A2 | 检查送进模型的请求 | 图像块 URL 指向 `ai-01.webp` **而非** L1 原件;image 块排在 text 块之前;**未**出现 base64 图像源 |
| A3 | 登记后立即查 job | `ai_job` 恰 1 行,`kind='stage1'`、`state='pending'`;**同事务投递**:回滚登记事务后 job 行不存在 |
| A4 | 跑完 S1 | job → `done`;`derived/{slug}/{sid}/extractions/s1-v{NNN}.json` 存在;含 `model`/`prompt_id`/`prompt_version`/`prompt_sha256`/`effort`/`usage` 六项,且 `model` 等于录制盒真实响应模型；缺一即失败 |
| A5 | 落库 | `document.doc_type ≠ 'unknown'`;`s1_artifact_key` 非空;**`person_id` 与登记时逐字节相同**(AI 不得改归属) |
| A6 | `full_text` 落点 | 数据库中**不存在**任何列含全文;全文只在 S1 工件内 |
| A7 | 重复投递 | 同 `(document_id,'stage1')` 再投递 → job 仍 1 行(唯一索引生效) |
| A8 | 僵尸回收 | 手工把 job 置 `running` 且 `locked_at` 回拨 20 分钟 → 回收器将其置回 `pending` 且 `attempt` +1 |
| A9 | PII 未外泄(**用合成号码**) | 回放一份含**合成手机号** `13800000000` 的单据(该号码**不属于任何人,录制盒对它不剥除**):`derived/**/extractions/` **之外**的任何 S3 对象与任何 DB 列中都不出现它。<br>**原版是同义反复**(审核 #004 A-10):回放时真实手机号已被剥除,"任何地方不出现"恒真,验证的是剥除脚本而非被审对象 |
| A9b | 结构化字段无丢弃类 PII(**不依赖模型自报**) | 对 `Stage1Out` 的**全部结构化字段**(含 `summary`)跑确定性手机号/身份证正则 → **命中即失败**。这条检的是 [03](./03-stage1.md) §3 表格里"丢弃类禁止出现在结构化字段"那条规范,且不依赖 `pii_spans` 标对没标对(审核 #004 B-3) |
| A10 | 归人对账 · 一致 | 姓名一致 → `person_check='match'`,无告警 |
| A11 | 归人对账 · 不一致 | 姓名不一致 → `person_check='mismatch'`;**`person_id` 未变**;`GET /documents?person_check=mismatch` 能列出它 |
| A12 | 归人告警确认 | `person_check_ack` → `person_check_ack_at` 非空(**`person_check` 保持 `mismatch` 不变**);journal 恰增一行该事件,载荷含 `observed_name`/`expected_name` 快照 |
| A12b | **★ ack 不被 L2 重跑抹掉** | A12 之后执行 A27 的重跑步骤 → `person_check_ack_at` **仍然非空**,告警未重现。这条是审核 #004 A-5 的直接判据 |
| A13 | 归人纠正(D15) | `POST /documents/:id/reassign` → 原目录新增 `correction-0001.json`;manifests 增一条修正行;**原件、`capture.json`、`page-NN.json` 的 (Key,VersionId,ETag) 逐字节不变** |
| A14 | 纠正后重建 | 删库 → migrate → seed → rebuild → 该文档归属为**纠正后**的 person(最后写入者胜);旧归属未复活 |
| A15 | facility 归一 · 首次 | 未命中决策缓存 → 调 AI → `normalization_decision` 新增 `proposed` 行;`document.facility_id` 已写 |
| A16 | facility 归一 · 复用 | 同 `input_fingerprint` 再来一份 → **不再调用 AI**(回放 transport 计数为 0);直接复用决策 |
| A17 | 归一确认 | 人工确认 → `state='confirmed'`;journal 增 `normalization_confirm` 一行 |
| A18a | 归组 · 有时分 · 命中 | 两侧 `event_time` 非空、差 11h → 产生建议,`grouping_basis='event_time'`。**未**自动建 `encounter` 行 |
| A18b | 归组 · 有时分 · 不命中 | 两侧 `event_time` 非空、差 13h → **不**产生建议 |
| A19a | 归组 · 无时分 · 跨日命中 | 两侧 `event_time` 均为空、`sampled_on` 为相邻两日 → 产生建议且 `grouping_basis='capture_date_degraded'`,UI 标注"判据较弱" |
| A19b | 归组 · 无时分 · 隔两日不命中 | 两侧 `event_time` 均为空、`sampled_on` 隔两日 → **不**产生建议 |
| — | (为何拆四条) | 原版 A18/A19 证明不了它宣称的命题(审核 #004 B-2):降级分支下 13h 之隔常落在相邻一日 ⇒ A18 后半句必失败;而 A19 无论走哪条分支都通过 ⇒ 对"用的是时间窗不是日历日"零信息量。**固件必须显式声明 `event_time` 的有无**,只有 A19b 才真正把"相邻一日"与"日历日"区分开 |
| A20 | 软删除 | `PATCH {archived:true}` → 列表默认不返回;`?include_archived=true` 返回;直访仍 200;派生物端点仍可用;journal + audit 各增一行;**L1 既有对象逐字节不变**(审核 #004 B-11 补) |
| A21 | 拆分(D7) | `POST /split` → 新文档页序从 1 连续;**`capture_order` 未改动**;原件字节不变;重复提交同 `client_operation_id` 返回首次结果且不产生第二次拆分 |
| A22 | 分片续传(D14) | 12 MiB 文件走三段式;在第 2 片后中断并刷新 → 续传完成;**服务端 GET 回流重算的整文件 sha256** 与源文件一致([06](./06-corrections.md) §4.5);`_incoming` 无残留;**L1 既有对象逐字节不变**(审核 #004 B-11 补) |
| A23 | 拒绝路径 | 注入 `stop_reason='refusal'` → job 直接 `needs_human`,`last_error.category` 已记录,**未**重试 |
| A24 | 超长输出 | 注入 `stop_reason='max_tokens'` → 以 32000 重试一次;再失败 → `needs_human` |
| A25 | 超 20 页分批 | 25 页文档 → 分 2 批,每批 ≤ 20;合并后 `pages` 恰 25 条且 `page_no` 无重复;工件含 `batches: 2` |
| A26 | 超限 PDF | 700 页 PDF → job `unsupported`,不重试,可在 `GET /jobs` 中查到 |
| A27 | **L2 可整体丢弃** | 删光 `derived/**` 与全部 `ai_job` 行 → 重跑 → S1 工件与 DB 派生列恢复;**L1 快照逐字节不变** |
| A28a | **L1 既有对象不可变** | 基线只取 `page-NN.*`(原件)、`capture.json`、`page-NN.json` 三类 key 的 (Key,VersionId,ETag);A 组结束时逐字节相同。**追加类对象(journal / manifests / `correction-NNNN.json`)不进基线**(审核 #003 A3) |
| A28b-1 | **WORM key 不得出新版本** | `page-NN.*`(原件)、`capture.json`、`page-NN.json`、`correction-NNNN.json` 四类 key 在 A 组全程**不得出现新版本**。这四类确实是 `If-None-Match: *` 仅创建写 |
| A28b-2 | **追加类只增不改** | journal / manifests / decisions / audit **允许**新增版本(`appendJsonl` 是读-改-写 + `If-Match`,同月第 2 行必然产生新版本);但**每个历史版本的行集合必须是新版本行集合的前缀** —— 这才是"只追加"在读-改-写模型下的可检验形式,且真能抓到丢行。<br>原版那句"追加类对象也是 `If-None-Match: *` 仅创建写"**是错的**:一事件一对象是 ADR-049,状态为**实现暂缓**,不在 M2 交付物内(审核 #004 A-3 / A-4) |
| A21b | 拆分后重建 | A21 之后删库 → migrate → seed → rebuild → **拆分结果原样复原**(页归属、页序、新文档均在);未复原即失败(审核 #003 A4) |
| A29 | 越权 | 他人文档的 `/ai`、`/rerun`、`/reassign` 一律 404,且与不存在不可区分 |
| A30 | 矩阵覆盖 | 桶内对象 ⊆ 权威矩阵,`parseKey` 全通过。**扫描范围写死在此**:含 `people/**`、`_index/**`、`derived/**`、`_meta/**`、`_incoming/**`;**无排除项**。<br>m0/m1 的同款扫描显式跳过 `derived/`(m0 还跳过 `_meta/`)—— M2 把二者纳入,因此 `MATCHERS` **必须**同时新增 extraction 与 `_meta` 两条,否则 A30 会先在 `gen-meta` 写的 `_meta/schemas/...` 上失败(审核 #004 B-5) |
| A31 | **`date_field` 筛选语义**(D15 清偿项) | `?date_field=sampled_on&from=&to=` 按 `sampled_on` 过滤;`?date_field` 省略时按 `capture_date`。**边界必须定死并断言:该列为 NULL 的文档一律不入选**(无论 from/to 如何)。原版此项无任何断言(审核 #004 B-11) |
| A32a | **merge** | 两文档合并 → 目标文档页序从 1 连续;源文档 `page_count` 归零并自动归档;原件字节不变;重复提交同 `client_operation_id` 返回首次结果 |
| A32b | **move-page** | 单页移动 → 两侧页序均重排为从 1 连续;`capture_order` 未改动;**两侧 `derived/` 前缀下的派生物均已删除**(审核 #004 B-7);重复提交幂等 |
| A32c | **移页后派生物不错配** | move-page 之后请求源文档 `preview-01`,其像素内容对应**重排后的第 1 页**,而非移走前的第 1 页。这条是 B-7 的直接判据 —— 缺了它,"看到别人的那一页"这类静默错误测不出来 |
| A14b | **PDF 正常路径**(非超限) | 3 页 PDF → S1 走 `document` 块 → `Stage1Out.pages` 恰 3 条且 `page_no` 为 1/2/3(PDF 内部页序);`document_page` 仍恰 1 行;**未**触发 §5 的页号冲突(审核 #004 A-13:原版只有 A26 的超限用例,正常 PDF 一条都没有) |
| A33 | **人工层回放 · 三件套** | 归档 3 份 + ack 2 条 + 确认 2 条归一 → 删库 → migrate → seed → rebuild → 三者**原样复原**:`archived_at` 非空、`person_check_ack_at` 非空、`normalization_decision` 为 `confirmed` 且 `facility` 行与 `aliases` 齐备([07](./07-replay.md) §4/§5) |
| A34 | **回放零 AI 调用** | A33 的重建全程 transport 调用计数 **= 0**;`ai_job` 表为空(重建不恢复 job 行,只按 [04](./04-jobs.md) §2.2 为缺 `s1_artifact_key` 的文档重新投递) |
| A35 | **回放幂等且不自增** | 对 A33 连续跑两次 rebuild:结果逐字段相同;`people/*/journal/**` 与 `_index/decisions/**` 的**行数不变**(重放禁止写回) |

## B. CI 断言

| # | 断言 |
|---|---|
| B1 | `packages/ai` 运行时只依赖 `@anthropic-ai/sdk`、`@amr/contracts`、`zod`、`zod-to-json-schema`;不 import `@amr/api` / `@amr/storage`。schema 工具不得成为第二套业务 contract |
| B2 | provider 默认模型 ID 只在 `packages/ai/src/models.ts` 出现。扫描范围**仅限** `packages/**/src`、`apps/**/src`、`tools/src`;同时扫描 `claude-*` 与 `deepseek-v*`;**必须**排除 `fixtures/**` 与 `docs/**`(审核 #003 A8 / CHANGES #14) |
| B3 | **缓存的可控前提**(离线可测):连续两次调用的 **system 块序列化字节逐字节相同**,且 `cache_control` 只出现在 system 上。<br>原版"第二次 `cache_read_input_tokens > 0"` 在强制回放下**要么恒真要么恒假**:两次请求指纹相同 ⇒ 命中同一个盒子 ⇒ 读到的是第一次(未命中)的 usage ⇒ 恒假;若为此录成两个盒子,断言的就是"我录了一个 `cache_read>0` 的 JSON 文件" ⇒ 恒真。真实命中率移入 C9(审核 #004 A-11) |
| B4 | **prompt 完整性**:篡改任一 prompt 文件而不改 `manifest.json` → 启动失败 |
| B5 | 新增 7 个 journal 事件在 `_meta/schemas`、`_meta/registries`、`_meta/README.md` 三处齐备 |
| B6 | 新增枚举与迁移 CHECK 值列表逐字相同(m0-99 B2 扩展) |
| B7 | `drizzle-kit generate` 无漂移(m1-99 B7) |
| B8 | **`appendJournal` 不覆盖调用方 `event_id`** 的回归单测(M1 已修缺陷,不得回归) |
| B9 | Stage1 schema 全部 `.strict()`:注入未知键 → 校验失败 |
| B10 | **禁止 Stage 2 泄漏**:全仓 grep 无 `observation` 表写入、无单位换算调用(M2 边界) |
| B11 | `ai` 变体生成的确定性:同一源图两次生成,sha256 相同 |
| B12 | 合并规则单测(三条可测性质,**删掉"与单批送 25 页一致"这个不存在的参照物** —— spec 自己禁止单请求 >20 图,审核 #004 B-10):<br>①`merge` 的 `pages` 按 `page_no` 严格递增且无重复,重复即抛错;<br>②`merge` 对页级字段**顺序无关**(打乱批次输入结果相同);<br>③`doc_type` 选取规则逐分支覆盖(含并列时取 `page_no` 最小批次) |
| B13 | **`verify-rebuild` 的字段表**必须含 [01](./01-contracts-delta.md) §5 标注为 **L1 人工层**的全部列(`archived_at`、`person_check_ack_at`、`encounter.grouping_basis`),必须**排除**全部 L2 可重算列。<br>否则:归档 3 份文档 → 删库重建 → 比对器打印"✓ documents 一致"并退出 0,而 `archived_at` 已全丢(审核 #004 B-8) |
| B14 | **录制盒 PII 静态扫描**:对 `fixtures/m2/cassettes/**` 全量跑手机号/身份证确定性正则,命中即失败。**不依赖模型自报的 `pii_spans`** —— ADR-044 的独立 PII 审计员在 M2 未实现,漏标一个号码就会随 git 历史永久扩散(审核 #004 B-9) |
| B15 | **无 L2 泄漏进 rebuild**:grep `tools/src/rebuild-index.ts` 无 `extractions` / `Stage1Out` 引用(审核 #004 B-7) |

## C. 提取质量(测量,不设通过线)

回归集:`fixtures/m2/regression/`,**必须** ≥ 20 份真实单据(项目所有者提供,经 PII 剥除后入库),覆盖化验单/影像/处方/输液单/体检至少各 2 份。

| # | 测量项 | 记录方式 |
|---|---|---|
| C1 | `doc_type` 准确率 | 混淆矩阵 + 总体准确率 |
| C2 | `sampled_on` / `reported_on` 准确率 | 精确匹配率;null 率单列 |
| C3 | `facility_name_raw` 准确率 | 精确匹配率 |
| C4 | `patient_name` 准确率 | 精确匹配率(直接决定归人对账的误报率) |
| C5 | `full_text` 覆盖率 | 人工标注的关键字段在全文中的命中率 |
| C6 | `doc_type_confidence` 的可用性 | 置信度分箱 vs 实际准确率(校准曲线);**若高置信区间的准确率不高于低置信区间,则该字段不可用于任何自动决策,须在 RESULTS 中写明** |
| C7 | 单页成本 | `usage` 实测均值与 $/页 |
| C8 | `pii_spans` 召回率 | 人工标注的丢弃类 PII 中被模型标出的比例(原 A9 后半句移入,审核 #004 B-3) |
| C9 | 缓存真实命中率 | 首次/二次调用的 `cache_read_input_tokens`(原 B3 后半句移入,审核 #004 A-11) |

> **C 组的运行环境例外(审核 #004 B-9)**:C 组走真实调用,而 Anthropic 服务端要去 fetch 图像 URL ——
> 指向本地 MinIO / compose 内网的预签名 URL **永远拉不到**,且失败信息是 API 侧的 image fetch 错误,不是"你的环境不对"。
> 因此 **C 组(且仅 C 组)允许用 base64 图像源**,它测的是提取质量而非请求形状。或改用真实对象存储运行 C 组。

结果 **必须**写入 `specs/m2/RESULTS.md` 作为基线。M5 设阈值时以此为起点。

## 完成定义

A(42 项)+ B(15 项)全绿,C 组基线已记录,D7/D14/D15/软删除四笔设计债勾销 → M2 关闭。
