# M1 Spec 审核 #002 · 合议记录(2026-08-18)

两名独立审查员(实现者可行性视角 / 忠实性与边界视角)+ 当事人复核。
发现:A 档 23+16(去重后 **31 项**)、B 档 19+12、C 档 5+5。**0 冤案**;当事人抽查的三条最重指控(幂等 payload 含 batch_id、thumb_key 在重建比对表、rebuild 从不读 journal)经代码核对全部属实。
双方独立命中同一要害 6 处:CORS 缺失、thumb_key 击穿重建、EXIF/captured_at、SW 读不到 token、失败即删原件、D13 悬空。

## 零、两条范围级裁决(先定范围,再定细节)

| # | 裁决 | 理由 |
|---|---|---|
| **S1** | **软删除整体推迟到 M2** | 它不在 09 的 M1 清单内(边界泄漏),却拖进 `archived_at` 列 + 迁移 + journal 新事件 + rebuild 回放 + 连带 D11,而 M1 验收句完全不需要它。M2 与归人纠正、D7 文档拆分同批做更自洽(共享"事后修改已归档文档"语义)。→ `document_archive` 事件、A12/A13 的归档断言、rebuild 的 journal 回放**全部退出 M1**。 |
| **S2** | **D11 与 D12 在 M1 内清偿,不改绑** | 二者按 design-debt 表头绑定 M1 / M1 前,"到期未清不得进入下一里程碑"。D11 收窄为**权限授予/撤销**写 `_index/audit/`(文档删除随 S1 移到 M2);D12 用 `account.token_epoch` + JWT `ep` claim 最小方案清偿。二者合计工作量小时级,不值得为省事而破坏门禁纪律。 |

## 一、A 档裁决表(31 项)

### 与 M0 已实现代码的硬冲突

| # | Blocker | 裁决 |
|---|---|---|
| 1 | **幂等 payload 含 `batch_id`**,而"每次重试重新 presign"必然改变它 → 任何"服务端已提交但客户端没收到 2xx"的重试都会 409 终止,直接击穿"一张不丢"与"不重复" | 服务端幂等比对口径改为**稳定语义子集** `{client_document_id, person_id, captured_at, source, confirmed_by, pages[page_no, sha256, width, height, capture_order]}`;`batch_id`/`upload_id` 排除。落 m0/CHANGES #4,同步改 `documents.ts` 与 m0-06 §3 |
| 2 | `thumb_key` 写入击穿重建等价性(A10 生成 → A13 重建为 NULL → 全列比对必红),且是 L2 缓存混进 L1 判据 | **M1 不写 `thumb_key`**(spec 自己承认判定以 HeadObject 为准,写它是只写不读的死列);并立规:凡值只能由 L2 生成的 DB 列,一律排除于重建等价性之外 |
| 3 | rebuild 从不读 journal(文件头注释撒谎),而 spec 要求回放归档 | 随 S1 消解;但**注释必须改正**,并登记 D16(journal 回放能力,绑 M3 —— 那时问答答案才真正需要回放) |
| 4 | `POST /uploads/presign` 的 400/404 与 S3 PUT 的 4xx 未分类;`sha256_mismatch`/`upload_consumed`/`internal_error` 无归属 | 错误分类表按 **presign / S3 PUT / register 三段**重写,对 `ERROR_CODES` 每个 code 显式给分类,并给"未列举 4xx 一律终止"的兜底规则 |

### 浏览器平台事实错误

| # | Blocker | 裁决 |
|---|---|---|
| 5 | **CORS 全链缺失**(API 侧与 S3 桶侧),而带 `x-amz-checksum-sha256` 的跨源 PUT 必触发预检 —— M1 第一跳就死 | 02 增 CORS 一节:`@fastify/cors` 白名单(env 注入,禁 `*`+credentials);桶 CORS 规则进 `provision-bucket` 自检(`AllowedHeaders` 含 `content-type`/`x-amz-checksum-*`,`ExposeHeaders=[ETag]`)。99 增跨源预检探针,置于 A2 之前 |
| 6 | `crypto.subtle.digest` **无增量接口**,"大文件分块读入"不可实现 | 删除"分块"表述:≤50 MiB 整块 `arrayBuffer()` + WebCrypto;并把单文件上限的**入队前**校验写死(不让它走到 presign 才 400) |
| 7 | **真机走局域网 IP = 非安全上下文**,`crypto.subtle`/SW/Web Locks/StorageManager 全部 undefined → C1/C2 根本跑不起来 | 99 §C 增 HTTPS 方案(mkcert 本地 CA 装入设备信任链)与"第 0 步:`window.isSecureContext === true`"前置断言 |
| 8 | **SW 读不到 `localStorage`**,且 Background Sync 触发时无 client 可转发 → SW `sync` 路径在设计上不成立 | 删除 SW `sync` 触发行与 C2 后半句;SW 只做外壳预缓存。与 ADR-046 一致 |
| 9 | `<img loading="lazy">` 对"先 fetch JSON 拿 url"的架构不生效,"兜底"是假保护;A9 的"请求数"口径未定义 | 派生物接口改为 **302 重定向**到预签名 URL(原生懒加载因此真的成立);A9 钉死视口尺寸、种子文档数 ≥30、计数对象为 `/thumb` 请求、计数窗口 |
| 10 | `<input capture multiple>` 在 iOS 上 `multiple` 被忽略 | 连拍 = 重复调起单张 `capture="environment"`,每张**立即**落盘;相册导入才用不带 `capture` 的 `multiple` |
| 11 | **WebKit 7 天存储清除 + 无 `persist()`**,队列里的原件可能被系统删掉 —— "一张不丢"最现实的失效路径,spec 零覆盖 | 04 §7 增:启动即 `persist()`(能力存在时)、未获持久化时 UI 显式降级提示、iOS 引导"加到主屏幕";`estimate()` 不可用时 fail-open 并记警告 |
| 12 | 直接持久化 `File` 实例可能跨会话失效(宿主临时文件被回收) | 入队时**必须** `new Blob([await file.arrayBuffer()], {type})` 物化;A3 增"读回 blob 校验 byte_size 与 sha256"断言 |

### 状态机与数据完整性

| # | Blocker | 裁决 |
|---|---|---|
| 13 | `done` 是否持久状态,四处自相矛盾(A4 断言"5 条全部 done" vs §9"元数据已删") | `done` 为**纯瞬态**:2xx 后同事务删两 store;A4 改断"`captures` 为空 + 服务端 5 份";正反馈由内存计数驱动 |
| 14 | `pending_discard` 不在枚举内;"blob 可先删"违反"非 done ⇒ blob 存在" | 枚举补全为 `draft/pending_person/pending/uploading/registering/pending_discard/failed_terminal`;不变式重述为"`pending|uploading|registering` ⇒ blob 完整存在" |
| 15 | **`failed_terminal` 自动 discard 会删掉唯一副本**(iOS `capture` 拍的照片常不落相册)—— 自己写的"一张不丢"的反例 | `failed_terminal` **禁止任何自动删除**;discard 唯一触发点是用户显式点"放弃"+ 二次确认 + 文案明写不可恢复;超限在入队前拦截 |
| 16 | **累积面板期间照片只在内存**,iOS 相机返回时标签页被回收即全丢 | 每页读入后**立即**写 `blobs` + `captures(draft)`;"完成"只是 draft→pending 并定稿 page_count;重启后草稿可恢复 |
| 17 | 退避与 A4 的 60s 窗口冲突(离线期 attempt 涨到 5~8,退避被推到 5 分钟) | 增两条硬规定:`navigator.onLine === false` 时不发起尝试、不增 attempt;`online` 与前台化必须把 `pending` 项的 `next_attempt_at` 置 0 |
| 18 | 多页文档的**部分失败语义**空白(5 页第 3 页失败怎么办) | 整批回 `pending` 全部重传(与"每次重新 presign"一致),并在 UI 显示已传字节被丢弃;登记 D14(分片续传) |

### 忠实性:未标注偏差与被悄悄推翻的决策

| # | Blocker | 裁决 |
|---|---|---|
| 19 | **推翻 ADR-013 决策句**("Service Worker 后台重试")却只标了"vs 09" | 新增 **ADR-046**(离线队列前台驱动,Background Sync 降为 Chromium 加成),修订 ADR-013 加 ⚠️;回写 01 §离线优先流程图、05、09 |
| 20 | **"分片 + 断点续传"整条消失**(01 §离线优先的规范性要点),未标偏差 | 04 §2 标偏差 + 登记 **D14**(绑 M2:预签名 multipart 需三段式与服务端状态) |
| 21 | **`captured_at` 不取 EXIF `DateTimeOriginal`** —— 相册导入的旧单据会永久落进今天的 key 目录(key 永不变),而 M1 正是"抢救存量"里程碑 | 05 §3 必须解析 EXIF(纯读取,不改字节):有 `DateTimeOriginal` 用之,否则用入队时刻并在 UI 标注;`PageIn` 增 `exif`,服务端原样落 `page-NN.json.exif`(勾销 m0-03 §4 的"M1 补"欠账) |
| 22 | **`confirmed_by` 永远写成 `api`** —— `capture_ui` 这个枚举值的存在意义就是记录 ADR-041 的核心断言,而它在 WORM 里锁 10 年 | `DocumentCreate` 增 `confirmed_by`(默认 `api` 保持兼容),PWA 一律传 `capture_ui`;m0/CHANGES #5;A4 增断言 |
| 23 | **`page_no = 拍摄顺序` 推翻 ADR-025**(该 ADR 的实证是"第 2 页先被拍到"),且 page_no 烧进 WORM key | 新增 **ADR-047**:key 中的 NN 恒为**拍摄序**,`page_no` 为语义页序,二者允许在 M2 后分离;`PageIn` 与 `capture.json.pages[]` 立即增 `capture_order`(拍摄瞬间即知的 L1 事实);ADR-025 加 ⚠️ |
| 24 | **归人:缓存缺失且离线 → 禁止拍照**,倒置了 05 §1 的顺序(设计是"拍→写盘=已存档→归人"),且把 ADR-041 的"离线可用"退化成"曾经在线过才可用" | 改为:登录成功即强制拉人员缓存;残余情况**允许拍照**,`person_id=null` + `pending_person` 状态,禁止 presign/上传,UI 红条提示。ADR-002"不允许无归属静默入库"完好 |
| 25 | **队列内禁止改归属**是以 ADR-041 之名加的私货(该 ADR 未如此规定),叠加 M1 无纠正路径 = 整个 M1 期错档不可逆,命中 00 §6 失败标准"把父母的数据混进自己的档案" | 允许在 `draft/pending_person/pending/failed_terminal` 且未成功 presign 时改归属(二次确认);已 `uploading` 后禁止(key 已定)。登记 **D15**(M1 期已上传文档的归人纠正,绑 M2) |
| 26 | `POST /captures/discard` 与两个新状态码不在 07;`docs/04 §3` 的 journal 事件清单未同步 | 逐条标偏差 + 回写 07(§2 接口清单、§8 错误码表)与 docs/04 §3 事件清单、`_meta/README` 与 registries |
| 27 | **D13 悬空引用**("已登记设计债 D13" —— 表里只有 D1–D12) | 追加 D13(PDF 缩略图,绑 M4)、D14、D15、D16;并增 CI 断言:spec 中出现的 `D\d+` 必须在 design-debt 中存在 |
| 28 | D11(绑 M1)未落地 | 见 S2:收窄为权限变更审计,M1 实现 |
| 29 | D12(绑 M1 前)被一句从句改绑 M2 | 见 S2:M1 实现最小吊销 |
| 30 | "原件字节零改动"裁决**不可证伪**(A4 断言"与本地计算值相等"是同义反复) | A4 改为与**注入 fixture 的已知 sha256**比对;增 A4b(原件 EXIF/GPS 完整保留)与 A4c(Orientation=6 的派生物长宽比正确),与 B4"派生物剥净"构成镜像断言 |
| 31 | **A 组全部依赖未定义的测试注入面**,且 `fakeJpeg` 不可解码 → A10/A11/B3/B4 必红;B4 是空断言(源本就无 EXIF) | 99 增"测试注入面"节(`VITE_M1_TEST_HOOKS` 下暴露 `window.__amr`:`enqueueFixture/queueSnapshot/pauseAt`)与"fixture 生成"节(确定性生成:含 GPS+Orientation=6 的 JPEG、无 EXIF 的 PNG、单页 PDF、>50MiB JPEG) |

## 二、B 档(实现注记,已并入各 spec)

IDB 跨 store 事务必须在网络调用**之外**新开(事务会在让出事件循环时自动提交);指定 `idb` 封装库;`navigator.locks` 亦是 secure-context-only;Background Sync 表述改为"仅 Chromium 系"(Firefox 同样不支持);迁移 0001 必须同步改 `schema.ts` 否则 drizzle-kit 漂移;A11 的版本清单取 `(Key,VersionId,ETag)` 且两次快照之间禁止任何写 API;`regen-derivatives` 必须用 admin 凭证(应用策略无 `derived/` 删除权);Playwright 需进 devDependencies + 编排脚本 `infra/run-m1.sh`;新错误码进 `ERROR_CODES`;`parseKey` 缺 `derived/` 匹配项(M0 历史欠账,一并补);`source` 取值映射写死(camera/album/pdf 三值可达,其余不可达);HEIC 在入队前拒绝并给可操作提示;`sharp.concurrency(1)` 移到启动时设置一次;10s 超时改述为"软超时,记录不阻断";派生物确定性限定为"同一二进制环境内";`api/` 客户端是手写薄封装(无 codegen);客户端时钟偏差 >24h 的提示文案;队列项与服务端文档的混排规则(队列项只显示当前所选人的);`createImageBitmap(blob,{imageOrientation:'none'})` 读原始像素尺寸,预览用 `<img>` 走 `from-image`;discard 的 advisory lock 纪律与 `event_id` 幂等;GET /identifiers 与 people 分页两笔 M0 欠账并入 02;惰性生成的角色与并发上限;跨文件引用统一为 `docs/NN` 或 `mN-NN` 前缀。

## 三、C 档(登记 / 显式接受)

- **D13** PDF 缩略图渲染(绑 M4,与 D5 同批)
- **D14** 分片 + 断点续传(绑 M2)
- **D15** M1 期已上传文档的归人纠正与连拍分组纠正(绑 M2,与 D7 同批)
- **D16** journal 回放能力(绑 M3;M1 无需要回放的 journal 事件落 DB)
- `from/to` 语义在 M2 接上 AI 日期后的迁移(随 D15 记录)
- 每次重试重新 presign 消耗 `doc_short_id`(2430 万空间,个人量级安全,显式接受)
- 剥离 ICC 导致广色域派生物色偏(原件完整,浏览层问题,M4 再议)
- `person_identifier` 跨 person 全局唯一(review-001 C 档遗留)→ 项目所有者裁决
- `[偏差:vs 无]` 是记号误用 → 改为"边界声明"
