# M2 Spec 审核 #004(独立对抗审核)

> 与 [review-003.md](./review-003.md)(作者自审)不同,本轮是**真正的独立审核**:两个独立上下文,
> 分别以「实现者」与「重建者/审计者」视角,且**未读** review-003 与 CHANGES —— 避免被既有结论锚定。

两轮**零重叠**,合计 19 条 A 档,而作者自审(#003)的 8 条与这 19 条也零重叠。三轮加起来 27 条 A 档 —— 这个数字本身就是"自审不能替代独立审核"的量化证据。

---

# 视角一 · 实现者

> 该审核员核实到 SDK 源码与官方文档层面,并在报告末尾列出了 20 余项"已核实无误"(不计入发现)——
> 包括 ADR-050 的全部技术断言、`output_config.effort`、`fallbacks` 的 beta 头配对、
> 视觉 token 公式与 2576px 档、PDF 的 32MB/600 页上限、Batch 结果顺序无保证等。
> **零误报**,与前三轮一致。

## A 档裁决(14 项)

> 去重说明:其中 7 项与视角二重叠(见下方对照表),此处只展开**视角一独有**或**同一问题但视角一给出了更严重后果**的条目。

| 视角一 | 视角二 | 处置 |
|---|---|---|
| A-1 `encounter_confirm` 第 8 个事件 | C-1 | 同一问题,按视角二裁决:统一为 `normalization_confirm` + `kind='encounter'` |
| A-2 decisions 落点 | A-2 | 同上,按"判断绑不绑人"分流 |
| A-3 key 含 `@` | B-5 | 同上,改 `extractions/s1-v{NNN}.json` |
| A-4 A28b 与 `appendJsonl` 冲突 | A-3 | 同上,拆 A28b-1 / A28b-2 |
| A-5 `event_at` 撞名 | B-1 | **按视角一的后果定档为 A** —— 见下方 A-5′ |
| A-12 split 新文档缺 prefix/capture_date | A-4 | 合并处置,见下方 A-12′ |
| A-14 软删除/归一确认重建后丢失 | A-1 | 同上,D16 最小切片提前到 M2 |

### A-5′ · `event_at` 撞名的真正后果:`dedup_key` 静默绑到恒 NULL 的旧列

视角二发现的是"`event_at` 没有写入方";视角一发现的是**更坏的一层**:`document` 表在 M0 就已有 `event_time`(注释"M0 建出恒 NULL"),而我在 `04 §2.1` 的 `dedup_key` 表达式里写的正是 `to_char(event_time, 'YYYY-MM-DD')` —— **这是一个真实存在的列,SQL 不会报错**,只会永远取到 NULL。

于是每个 person 的所有 `encounter_suggest` 作业的 `dedup_key` 都退化成 `'encounter:<pid>:'`,`uq_ai_job_dedup` 把这个人**一生的归组作业压成一行**,`ON CONFLICT DO NOTHING` 静默吞掉全部后续投递。表现是"归组建议莫名其妙只出现过一次"。

> 这正是我在 `00 §4.4` 里给自己立的规矩要防的那类事 —— 而我自己在写 `04 §2.1` 时踩了进去。**撞名 + 恒 NULL + 静默吞掉**,三者叠加,没有任何一处会报错。

**裁决:** ①复用既有 `document.event_time` / `event_time_source`(按 docs/03 §226 的语义填),删掉 `01 §5` 的 `event_at` 行;②`encounter` 上另立 `grouping_basis` 承载 `event_at|capture_date_degraded`,避免同名列在两张表里表示两件事;③全 spec 统一术语,**禁止** `event_at` 与 `event_time` 混用;④`03 §6` 的落库表必须补上 `event_time` 与 `event_time_source` 的写入规则。

### A-6 · `dedup_key` 按日历日切分,与 `05 §3`「禁止按日历日」当场自相矛盾

`05 §3` 用整段论证"不能假装有时分""恰好退化成 ADR-037 明令禁止的按日历日归组",而 `04 §2.1` 的去重键恰恰是 `to_char(event_time,'YYYY-MM-DD')` —— **按日历日切分作业**。A19 的用例(23:50 与次日 00:30)天然落在两个日历日 ⇒ 产生两条作业,哪条负责评估这一对?候选集是什么?spec 没说。

**裁决:** 去重维度必须与**候选集定义**一致。改为 `person_id` 级的合并型作业:`dedup_key = 'encounter:' || person_id`,冲突时 `ON CONFLICT DO UPDATE` 刷新 `next_attempt_at`(而不是 DO NOTHING)。`05 §3` 必须补一句"一次 `encounter_suggest` 作业的候选集范围 = 该 person 全部未归组文档"。

### A-7 · `facility_normalize` 跨人去重 + 只绑一个文档 ⇒ 同院第二份起永远拿不到 `facility_id`

三条约束互相打架:`ai_job.person_id NOT NULL`、`dedup_key = 'facility:' || fingerprint`(跨人跨文档唯一)、"重复投递必须 `ON CONFLICT DO NOTHING`"。用户一次扫同院 5 份单据:第 1 份投递成功,第 2–5 份被静默丢弃;那条唯一作业完成后**写谁的 `facility_id`**?第 2–5 份永远为空,且无任何信号 —— 违反我自己在 `04 §5` 写的"禁止任何'失败就静默跳过'的路径"。

**裁决:** ①`05 §2.2` 执行层的职责改写为"**回填全部** `facility_name_raw` 指纹相同且 `facility_id` 为空的文档",不是只写触发文档;②`ai_job.person_id` 改为可空 + `CHECK (kind <> 'stage1' OR person_id IS NOT NULL)`;③`04 §5.1` 的 `GET /jobs` 鉴权对跨人作业需另立规则(家庭级作业对全部有 editor 权限的人可见)。

### A-8 · 非流式 `max_tokens: 32000` + 显式 `timeout` ⇒ SDK 守卫被关掉,请求注定超时

审核员核到了 SDK 源码:`calculateNonstreamingTimeout` 在 `expectedTime = 3_600_000 × maxTokens / 128_000 > 600_000` 时抛错(即 `max_tokens > 21333`),**但该守卫只在没有显式 timeout 时生效** —— 而我在 `02 §1` 恰好显式设了 `timeout: 600000`,把它关掉了。

后果链:32000 tokens 的预期生成时间是 900 秒,客户端 600 秒 abort ⇒ 超时属可重试 ⇒ SDK 默认 `maxRetries=2` 再打两次同样注定超时的 Opus 调用(每次都产生已计费输出)⇒ 抛 `APIConnectionError` ⇒ 按 `§5.4` 归"可重试" ⇒ 烧满 5 个 attempt ⇒ 终态 `failed` 而**不是** `§5.4` 承诺的 `needs_human`。单份长文档最坏 15 次十分钟级 Opus 调用。而 A24 在回放下通过,真实路径从未被测到。

**裁决:** 32000 重试路径**必须**改用 `client.beta.messages.stream(...)` + `.finalMessage()`(docs/06 §9 本来就是这么写的)。`02 §1` 的显式 timeout 保留,但必须写明"这会关闭 SDK 的非流式长请求守卫,因此 `max_tokens` 上限由本 spec 自行约束"。

### A-9 · 分片上传无法"沿用既有 sha256 校验路径"(与视角二 B-4 同源,但给出了更完整的证据)

除复合校验和问题外,视角一还指出:`sign` 载荷 `{upload_id, part_numbers[]}` **不携带任何 per-part checksum**,`complete` 载荷只有 `{part_number, etag}` —— 即便想做复合校验也**缺输入**。

**裁决:** 采纳"`complete` 后服务端 GET 回流重算整文件 sha256 再走 Head-then-Copy"。`06 §4.5` 那句"沿用既有路径"必须删除并写死方案。

### A-10 · 录制盒剥除 PII 让 A9 变成同义反复,且使 `pii_spans` 偏移失效

回放时手机号已被剥掉 ⇒"任何地方不出现该手机号"**恒真**,验证的是剥除脚本而非被审对象。且若剥除是**删除**,`full_text` 长度改变,`pii_spans` 的 UTF-16 偏移全部错位。

**裁决:** ①A9 改用**合成手机号**(`13800000000`)且录制盒对它**不剥除** —— 它不是真实 PII,断言这才真正测"这串数字有没有从 extractions 漏到别处";②`§0.4` 明确剥除方式为**等长遮蔽**(保持 `full_text` 长度不变,`pii_spans` 仍可校验),遮蔽字符给出精确值。

### A-11 · B3(缓存命中)在强制回放下不可测 —— 要么恒真,要么恒假

B3 在 B 组 ⇒ 必须回放。而"连续两次同 prompt 调用"按 `§0.2` 的指纹定义**指纹完全相同** ⇒ 命中同一个盒子 ⇒ 第二次读到的是第一次(未命中)的 usage ⇒ 恒假。若为了让它过而录成两个盒子,断言的就是"我录了一个 `cache_read>0` 的 JSON 文件" ⇒ 恒真。

> 缓存纪律是这个里程碑唯一的成本控制手段,而它恰恰是唯一给了断言却测不出来的东西。

**裁决:** 拆成两条 —— ①B 组保留一条**真正离线可测**的:"两次请求的 system 块序列化字节逐字节相同"(这是缓存能否命中的可控前提);②真实命中率移入 C 组测量(C9)。

### A-13 · 多页 PDF 的 `page_no` 语义未定义

一份 5 页 PDF 在 L1 与 DB 里是**一个** `document_page` 行(m0-03 §2:1 个 PDF = 1 个 page 对象),而模型会返回 5 个 `Stage1Page`。`page_no` 是 PDF 内页序还是 `document_page.page_no`?若取后者,`03 §5.2` 的"同 `page_no` 出现两次 → 失败"会让 5 页 PDF **立刻自撞 `needs_human`**。`02 §3.4` 的"每张图前插 `第 N 页:`"对 `document` 块也完全不适用。

**裁决:** `03 §1` 补:PDF 文档的 `Stage1Page.page_no` 是 **PDF 内部页序**,与 `document_page.page_no` 不同源;M2 **不为** PDF 建 `document_page` 展开行(页级定位是 D5/M4 的事);`03 §5.2` 的冲突检查按"同一 `document_page` 内的 PDF 内页序"作用域执行。A 组补一条正常 PDF 的端到端断言(现在只有 A26 的超限用例)。

### A-12′ · split 新文档的 `prefix` 与 `capture_date` 未定义

`ManifestAdd.prefix` 必填、`document.capture_date` NOT NULL,而新文档"没有自己的目录"。两个实现者会填出两种结果,其中一种重建不出来。

**裁决:** 与视角二 A-4 合并处置 —— 采纳"**新文档必须在源目录写自己的 `capture.json`**"之外,再定死:新文档的 `prefix` = **源文档目录**(新文档共用源文档的物理前缀,这是 D7 不动原件的直接后果),`capture_date` = 源文档的 `capture_date`。并补一条与 ADR-047 同构的分离声明:**新文档的 `derived/` 前缀用新 `short_id`,L1 前缀用源 `short_id`,`parseKey` 与月度对账不得假定二者一致。**

## B 档(12 项,全部采纳)

| # | 事项 | 裁决要点 |
|---|---|---|
| B-1 | `norm()` 未给精确字符集与大小写规则 | 定死:NFKC → `toLowerCase()` → 删 `\p{White_Space}` + **逐字列出**的分隔符集合(`·‧•・.,,、-‐-‒–—_/\`),常量放 contracts + 单测 |
| B-2 | `input_fingerprint` 的 `city_hint` 无可靠来源 ⇒ A16 随机失败 | M2 删掉 `city_hint`,指纹 = `sha256(canonical({raw_name: norm(facility_name_raw)}))` |
| B-3 | `doc_type_confidence` 等三列并非新列,且类型被写错(`numeric`→`real`) | 逐行核对 schema.ts 后重写 `01 §5`,加"既有/新增"列;保持 `numeric` |
| B-4 | `CorrectionSidecar` 扩展的形状与排序字段对不上(`corrected_at` vs `created_at`;`seq` 是目录内计数却用作全局次键) | 写在**源文档目录**;排序键 `(corrected_at, from_doc_short_id, seq)`;`schema_version` 升 `'1.1'` 并同步 `_meta/schemas` |
| B-5 | merge/move-page 要"在 manifests 追加"但 `ManifestLine` 只有两个 op | 明确**不写** manifests,页归属完全由 `correction-*.json` 承载,并改掉 `06 §3.1` 开头那句 |
| B-6 | `reassign` 与 `archive` 无幂等键 ⇒ 重试产生第二条 correction/manifest/journal(而这些是**只增不改**的 L1,写错了删不掉) | 二者一并接受 `client_operation_id`;`01 §4.2` 改写为"**客户端提供 `event_id` 时禁止覆盖**;服务端自发事件由服务端生成" |
| B-7 | 页号重排后旧派生物与新 `page_no` **错配** ⇒ 静默显示错误的页 | `06 §2.6` 补:任何改变 `page_no` 的操作**必须删除**受影响文档 `derived/{slug}/{sid}/` 下全部派生物;A21 加像素级断言。**与 D19(残留)不是同一问题 —— 这是错配** |
| B-8 | "重试一次"无持久化落点 ⇒ `max_tokens`/Zod 的终态退化成 `failed` | 规定二次重试**在同一次取件内同步完成**,不经过 `pending` |
| B-9 | C 组要真实调用 + 预签名 URL,而验收环境是本地 MinIO(Anthropic 侧拉不到) | C 组明确开例外:**可以**用 base64 图像源(仅此一处),因为它测的是提取质量而非请求形状 |
| B-10 | B12 的"与单批送 25 页一致"参照物不存在(spec 自己禁止单请求 >20 图) | 改写为可测的合并性质:页号严格递增无重复、批次顺序无关、`doc_type` 选取逐分支覆盖 |
| B-11 | 三处规范性条文在 99 里没有对应断言(`date_field` 迁移、merge/move-page、软删除与分片的 L1 快照) | 补 A31/A32,并给 A20/A22 补上 L1 快照断言 |
| B-12 | 工件已写但 DB 回滚后重试 ⇒ 412 不在错误分类表里 | `§5.4` 加一行:S3 `PreconditionFailed`(同版本工件已存在)→ **读取既有工件、跳过模型调用、直接落库** |

## C 档(4 项,全部采纳)

| # | 事项 | 处置 |
|---|---|---|
| C-1 | `00 §5` 偏差 #4 的事实与回写目标都写错了(docs/06 **§9** 早已完整写了 refusal 与 fallback,不是"未涉及";§5 是归一化,无关) | 整行改写为"docs/06 §9 已有,spec 只是把建议升格为必须并补了终态处置" |
| C-2 | `extractions/` 命名与 docs/04 §2 的 `vNNN-rN` 不一致,未登记偏差 | `00 §5` 加一行偏差并说明 M2 无轮次维度的理由(禁止闭环重读) |
| C-3 | `encounter.event_time_source` 未标注可空性 | 明确"可空;归组确认时写入,NULL 表示 M2 之前建的 encounter" |
| C-4 | `facility.slug` 生成规则与唯一性未定义(表上**无唯一索引**,并发/重跑可能建重复行) | 给最小规则(`'f' + 5×A`,复用 m0-03 §1 字母表与 CSPRNG),`aliases` 由执行层追加;或登记设计债绑 M4 |

---

# 合并统计

| 轮次 | A | B | C |
|---|---|---|---|
| #003 作者自审 | 8 | 5 | 2 |
| #004 视角一(实现者) | 14 | 12 | 4 |
| #004 视角二(重建者) | 5 | 9 | 5 |
| **合计(去重后)** | **19** | **21** | **9** |

三轮**两两零重叠**。自审查的是"这份 spec 内部说得通吗";实现者查的是"照着它写代码会不会撞墙";重建者查的是"它承诺的东西在删库之后还在不在"。三个问题不同,答案也不同 —— 没有任何一个能替代另外两个。

**最该记住的一条:** 我在 `00 §4.4` 给自己立了"模型说的话可以重来,人说的话不能"这条判据,却在 `04 §2.1` 写出了一个静默绑到恒 NULL 旧列的 `dedup_key`,在 `05 §1` 让人的 ack 存进一个 AI 会重算的列。**立规矩和守规矩是两件事**,而只有外部视角能查出后者。

---

# 视角二 · 重建者/审计者

### 一句话结论(审核员原文)

> M2 在"AI 产出属 L2"这一侧守得很干净,破口全部在**另一侧** —— M2 新增了五类人的判断(归档、ack、归一确认、归组确认、拆分),其中三类没有回放路径、一类没有合法的落桶位置、一类会被例行重跑抹掉、一类的 L1 载体字段不够。M2 结束时"仅凭桶重建"这句话对 M2 新增的人工层是**不成立**的。

**这正是自审抓不到的那一类。** review-003 逐条查了内部矛盾与事实错误(并且都查对了),但它整轮都站在"这份 spec 说了什么"里面看;而这一轮问的是"删库之后这份 spec 承诺的东西还在不在"—— 一个从外部才提得出的问题。

---

## A 档裁决(5 项,均已抽查核实)

### A-1 · journal 双写了,但没有任何回放方 —— 三类人工判断在重建后消失

**核实:** `rebuild-index.ts` 文件头写着输入含 journal,正文**一处也没读**;D16 已登记此事并把回放绑在 M3。而我的 `05 §4.3` 却是规范性条文:「`confirmed` 行**必须**能从 journal 回放恢复」。规范说能、实现不能、验收不查 —— 三者俱全。

**失败场景(审核员给出,已确认可复现):** 归档 8 张废片 + ack 5 条归人告警 + 确认 12 条机构归一 → 删库重建 → ①8 份文档**全部复活**且 `archived_at` 为 null;②按 `04 §2.2` 它们还会被**重新投递 stage1 作业,重新付费调模型**;③5 条 ack 丢失,告警重现;④12 条 confirmed 归一退回不存在,需重新调 AI 并重新人工确认 12 次。

**裁决:采纳选项①,并上调 D16 的绑定。** journal 回放(`document_archive` / `person_check_ack` / `normalization_confirm` 三型)**提前到 M2**,`rebuild-index` 增第 4 步:扫描 `people/*/journal/**` 与 `_index/decisions/**`,按 `(at, event_id)` 排序重放,`event_id` 幂等。

> D16 当初把回放绑 M3,理由是"M3 的问答答案是第一个必须回放到 DB 的人工层事件"。**M2 证明这个判断错了** —— 归档、ack、归一确认都是必须回放的人工层事件,而它们出现在 M2。债的绑定跟着事实走,不跟着当初的猜测走。

### A-2 · `normalization_confirm` 没有合法落点;矩阵为它准备的 `_index/decisions/` 在 M2 spec 里零引用

**核实:** `docs/04 §1` 矩阵第 42 行确有 `_index/decisions/*.jsonl`,层标注「人工(全家共享词表)」;`grep -rn decisions specs/m2/` 结果为**空**。而 `appendJournal(tx, personSlug, …)` 的 `personSlug` 是必填的,facility 归一(`sha256(raw_name)` → 机构)**没有 person 维度**。

**失败场景:** 确认「北京协和医院 = xiehe」时被迫填一个 personSlug(只能是碰巧触发这次归一的那份文档的归属人)⇒ 家庭共享词表被随机切碎散落进 5 个人的 journal;按 `04 §5` 做单人导出时,孩子会拿到父母档案触发的机构决策,或反过来自己缺词表。且 `facility` 表既不在 rebuild-index 里也不在任何 L1 对象里 —— **删库后整张表连同所有已确认归一一起消失**。

**裁决:按"判断绑不绑人"分流,不按"是不是人做的"分流。**
- **不绑人**的确认(facility 归一)→ `_index/decisions/{YYYY-MM}.jsonl`,全家共享,打包必带。
- **绑人**的确认(encounter 归组、`person_check_ack`)→ per-person journal。
- 两者的载荷 schema 均进 `packages/contracts`;`_meta` 三处同步。
- `05 §2.5` 的"词表快照随 `_meta/registries/` 落桶"必须指明触发时机与执行者 —— `gen-meta` 现在只导出编译期常量,导不出运行期 facility 表。

### A-3 · A28b 与现行追加实现直接矛盾,且我给的理由是错的

**核实:** `appendJsonl` 是 GET 整份 → 拼接 → `PutObject` 带 `IfMatch`。同月第 2 条 journal 行**必然**在同一 key 上产生新版本。`docs/04 §308` 自己也写着「追加 = 重写整对象 = 新版本新锁」。ADR-049(一事件一对象)状态是**实现暂缓**,不在 M2 交付物里。

> 我在 review-003 A3 里已经发现 A28 与 journal 写入冲突,拆成了 A28a/A28b —— 但**给 A28b 编的理由("追加类对象也是 If-None-Match 仅创建写")是错的**,那句话对 journal 根本不成立。自审能发现矛盾,却把矛盾解释错了;独立审核连解释一起纠了。

**裁决:** A28b 改写为两条 ——
- **A28b-1**:`page-NN.*` / `capture.json` / `page-NN.json` / `correction-NNNN.json` 四类 WORM key **不得出现新版本**(这四类确实是仅创建写)。
- **A28b-2**:journal / manifests / decisions / audit **允许**新增版本,但**每个历史版本的行集合必须是新版本行集合的前缀** —— 这才是"只追加"在读-改-写模型下的可检验形式,且真能抓到丢行。

同时在 `00 §5` 偏差表登记「ADR-049 暂缓,M2 沿用 M0 的追加语义」。

### A-4 · 拆分产生的新文档在桶里没有 L1 载体,A21b 按现有契约不可能通过

**核实:** `ManifestAdd` 恰有 7 个字段且 `.strict()`;而 `document` 的 NOT NULL 列里,`id`/`source`/`captured_at`/`capture_date`/`uploaded_by`/`client_document_id` 六项在 add 行与 `page_move` 载荷里**都没有**。`rebuild-index` 现行逻辑对取不到 `capture.json` 的目录直接记幽灵行并 `continue`。

**裁决:采纳"新文档必须写自己的 `capture.json`"。** 理由:它保住了 `docs/04 §8` 既有的不变式「每个文档目录必有 capture.json」,而扩展 `ManifestAdd` 会让 manifest 行承担它本不该承担的完整文档事实。新 `capture.json` 的 `source='split'`,`pages` 引用原 key,`client_document_id` 由拆分操作的 `client_operation_id` 派生(确定性,可重放)。
`CorrectionSidecar` 改判别联合并 bump `schema_version`;`06 §3.1` 必须写明 move/merge 在 manifests 用什么 `op`,或明确"不进 manifests"。二者都要在 `01-contracts-delta` 登记。

### A-5 · 人的 ack 存进了一个 AI 会重算的列;A27 这条验收步骤本身就会把它抹掉

**核实:** `05 §1.1` 要求 S1 完成后必须重算比对并写 `person_check`;`05 §1.6` 让人工 ack 把同一列置 `skipped`;全篇**没有**"`skipped` 不得被重算覆盖"的规则。而 A27 的步骤正是"删光 derived + ai_job → 重跑"。

**失败场景:** 报告印的是家长姓名、被检人是孩子(这是 `05 §1.6` 自己举的例子,即**永久不可能匹配**)—— 用户 ack 一次;此后任何一次 L2 重跑都会把它写回 `mismatch`,用户被迫每次模型升级后重新 ack 全家所有此类文档。

**裁决:拆列。** `document.person_check` 保留为 L2 可重算的比对结果;新增 `person_check_ack_at`(人工层,可空,journal 可回放)。UI 告警条件改为 `person_check='mismatch' AND person_check_ack_at IS NULL`。`05 §1` 增规范性条文:「比对**禁止**写入或清除任何人工层列」。A12 之后增断言:「A27 重跑后 ack 仍然生效」。

---

## B 档(9 项,全部采纳)

| # | 事项 | 裁决 |
|---|---|---|
| B-1 | `document.event_at` 没有写入方,且与 M0 既有的 `event_time`/`event_time_source` 语义重复 | 复用既有 `document.event_time` + `event_time_source`(按 docs/03 §226 填);`encounter` 上另立 `grouping_basis` 承载 `event_at\|capture_date_degraded`。`03 §6` 落库表**必须**补上这一列 |
| B-2 | A18/A19 证明不了它们宣称的命题(降级分支下 13h 常落相邻一日 ⇒ A18 必失败) | 拆成四条,固件显式声明 `event_at` 有无:双非空 11h 命中 / 13h 不命中 / 双空跨日命中且标 degraded / 双空隔两日不命中 |
| B-3 | A9 是同义反复(M2 结构上就没有把全文写出 extractions 的路径),后半句是模型质量断言却放进必须 100% 通过的 A 组 | 前半句降级为 B 组静态断言;后半句移 C 组作召回率基线(C8);A 组补一条**真有内容**的:对 `Stage1Out` 全部结构化字段跑确定性手机号/身份证正则,命中即失败 |
| B-4 | 分片对象的 `ChecksumSHA256` 是复合值(带 `-N`),与整文件 sha256 永不相等 ⇒ A22 不可达 | `complete` 后**下载并重算整文件 sha256** 再走 Head-then-Copy;与 ADR-048 为 R2 选的方案一致,顺带还了那笔债 |
| B-5 | 工件 key 含 `@`,违反 `KEY_BYTES_RE`;`parseKey` 无 `extractions` 匹配器;A30 要扫 `derived/` 而既有实现本就排除它 | key 改 `extractions/s1-v{NNN}.json`(纯 `[a-z0-9-]`);登记 `ParsedKey.extraction` + `buildKey.extraction` + `_meta` 匹配器;A30 的排除清单**必须**写死在 spec 里 |
| B-6 | 归人纠正后 S1 工件用哪个 slug 前缀未定义 ⇒ 重建时按权威 slug 查找对所有被纠正文档静默落空 | `{slug}` 恒取**权威归属 slug**;纠正时**必须**把 `s1_artifact_key` 置 null,强制下次按新前缀重生 |
| B-7 | 让 `rebuild-index` 读 L2 工件,与 `docs/04 §3`「rebuild 不需理解任何 AI 语义」冲突,且冷备里根本没有 `derived/` ⇒ 该路径真实恢复时 100% 走不到 | 删掉 `03 §6.3` 对 rebuild 的要求。L2 列的恢复由 `04 §2.2` 既有的"为缺 `s1_artifact_key` 的文档重新投递 stage1"承担。**演练必须能代表真实恢复** —— 否则「没演练过的备份等于没有备份」整套逻辑失效 |
| B-8 | `verify-rebuild` 的"穷尽字段表"没扩展,M2 的人工层列全不在比对内 ⇒ 归档丢失也会打印"✓ documents 一致" | 增 B13:字段表**必须**含 M2 新增的全部人工层列,**必须**排除纯 L2 列;`01 §5` 每列标注"L1 人工 / L2 可重算" |
| B-9 | 录制盒/回归集把真实病历提交进 git,而剥除只依赖同一个模型自报的 `pii_spans`(ADR-044 的独立审计员在 M2 未实现);且保留类 PII(姓名/机构/检验结果)本就不在剥除范围 | 三条:①剥除**必须**在解码后的字符串上做再重新序列化,并增 B 组断言"对录制盒全量跑正则,命中即失败"(不依赖模型自报);②保留类必须做替换(姓名→P1、机构→F1),**或**明确写下"接受真实姓名入库"——不能默认;③若保留真实数据,`fixtures/m2/{cassettes,regression}` 放进独立私有子模块 |

> B-9 的第②条涉及隐私取舍,按项目所有者一贯立场(「功能高于隐私,具体隐私保护我自己判断」)**留给项目所有者决定**,spec 里先按"必须替换"写,并标注这是可由所有者放宽的一条。

## C 档(5 项,全部采纳)

| # | 事项 | 处置 |
|---|---|---|
| C-1 | `encounter_confirm` 与 `normalization_confirm` 事件名冲突 | 统一为 `normalization_confirm` + `kind='encounter'`,删掉 `05 §3` 的另立名称 |
| C-2 | `AuditLine` 未扩展文档删除 op ⇒ `appendAudit` 的 parse 直接抛错,A20 过不去 | `01 §4` 增登记 `AuditDocumentArchive`,纳入 B5 三处同步断言 |
| C-3 | `01 §5` 把三个 M0 已存在的列列为"新增",其中 `doc_type_confidence` 还换了类型(`numeric`→`real`) | 表加一列"M0/M1 是否已存在";`doc_type_confidence` 保持 `numeric` |
| C-4 | `person_check_ack` 载荷不含判断依据,而依据只在可丢的 L2 工件里 | 载荷增 `observed_name` 与 `expected_name` 快照 —— 与 `capture.json` 里 `person.name` 快照同理:**人工判断的依据必须随判断一起进 L1,不能引用一个可丢层** |
| C-5 | `correction-NNNN.json` 的 `seq` 并发下无重试规则,而 `putWorm` 现行把 412 映射为 `'exists'` ⇒ 可能静默丢弃一次纠正 | `06 §5` 增:412 时**必须**重新 LIST 取 `max(seq)+1` 重试(≤3 次),**禁止**把 412 当幂等成功;幂等由 `client_operation_id` 承担 |

---

## 统计

| 轮次 | A | B | C |
|---|---|---|---|
| #003 作者自审 | 8 | 5 | 2 |
| #004 视角二(重建者) | 5 | 9 | 5 |

两轮零重叠 —— 自审抓的是"这份 spec 内部说得通吗",独立审核抓的是"这份 spec 承诺的东西在真实世界成立吗"。**两者不可互相替代。**
