# M0 Spec 审核 #001 · 合议记录(2026-08-17)

两名独立审查员(视角:实现者欠定/歧义;设计忠实性/边界)+ 当事人复核。
发现:A 档 17+10(去重后 **19 项独立 blocker**)、B 档 21+9、C 档 6+4。全部 A 档裁决有效,0 冤案。
两人独立命中同一要害 5 处(presign/key 矛盾、WORM 验收命令必红、双写幽灵行、journal 丢 identifiers、归档不落桶)。

## A 档裁决与去向(spec 已按此修订)

| # | Blocker | 裁决 | 修订落点 |
|---|---|---|---|
| 1 | presign 声称定最终 key,但 capture_date/page_no 在 ③ 才存在 | presign 只预留 short_id 与 `_incoming` key,最终 key 在 ③ 计算 | 06 §2;02 补 `upload_batch`/`upload_file` 表(10 表) |
| 2 | CopyObject 无目标端条件写(AWS/MinIO) | 改 Head-then-Copy,竞态由 DB 幂等 + `storage_key UNIQUE` 兜底;PutObject 路径保留 If-None-Match | 06 §2③;04 §2 探针断言 |
| 3 | versioning 下裸 PUT 必成功,WORM 验收命令必红;"不可覆盖"是夸大 | 语义改为"**版本不可销毁** + 应用条件写纪律";验收命令重写(条件写 412 / 裸 PUT 出新版本 / delete marker 可发现可恢复) | 04 §4;00 §4 |
| 4 | `upload` 表/`_incoming` lifecycle 无人定义,TTL 三处矛盾 | 表 DDL 进 02;lifecycle(含 Noncurrent)进 04 §1 建桶表;TTL 统一:URL 15min / 批次 24h / `_incoming` 7d | 02、04、06 |
| 5 | ③ 中途删临时对象 → 崩溃后永久不可重试 | 临时删除移到 DB 提交后;重试时"临时缺失 → 回查最终 key + sha256 一致视为已搬运" | 06 §2③、§3 |
| 6 | A10 重建无 account/person_access 来源;person.id 重建后漂移 | `_person.json`/journal 快照**含 person.id 与 identifiers**;重建流程 = seed → rebuild → 补授权;account/person_access 显式排除在重建等价性之外 | 01 §5、03 §4、99 A10 |
| 7 | journal 快照与 `_person.json` 不同构(丢 identifiers) | 定义 `PersonSidecar`(id + identifiers 全量),两处共用 | 01 §5 |
| 8 | canonical "字典序" vs "schema_version 居首" 矛盾 | 钉死:schema_version 居首,其余键递归字典序 | 03 §4 |
| 9 | PDF 的 page 语义未定 | 1 个 PDF 文件 = 1 个 page 对象;width/height = 首页 MediaBox 取整 pt(≥1) | 03 §5、01 §4 |
| 10 | PATCH `.partial()` × `.default()` 会静默清过敏史 | JSON Merge Patch 语义;PersonUpdate 从无 default 基底派生;验收加单字段 PATCH 断言 | 01 §3;99 A12 |
| 11 | document 路由无合法授权路径 | 新增 `requireDocumentAccess`,与 requirePersonAccess 同为唯一检查点 | 05 §3 |
| 12 | contracts 缺 login/presign/响应 schema、429/413/422;404吞403 未标偏差 | 补全;错误码统一 `internal_error`;`[偏差:vs 07 §8]` 标注并回写 07(移除 403 行) | 01;docs/07 |
| 13 | `captured_at` "合理性"未定义 | ∈ [2000-01-01, now+24h],否则 400 | 01 §4 |
| 14 | S3 追加成功 + DB COMMIT 失败 → 幽灵行,且版本已上锁不可救 | 写序钉死(S3 追加为 COMMIT 前最后一步);journal/manifest 行带 `event_id`;回放按 event_id 幂等、无 capture.json 佐证的 add 进对账报告;docs/04 §4 "旧版本未上锁"措辞错误 → 回写 | 03 §5;99 A10;docs/04 |
| 15 | presigned PUT 无 content-length-range;"无法带锁参数"是错误断言 | 尺寸在 ③ HeadObject 强制(413);`_incoming` 理由改真(最终 key 未知 + 校验前不上锁);sha256 用签入的 `x-amz-checksum-sha256` | 06 §2 |
| 16 | 归档(DELETE)"S3 不动" → 重建复活死档 | 归档 = 一次编辑:五步全走(含 `_person.json` archived_at + journal);"S3 不动"限定为原件 | 06 §1;99 A11 |
| 17 | correction schema 声称在 03 定义,实际没有 | 03 §4 补 schema(与 docs/04 §2 一致),`_meta/schemas/` 清单同步 | 03、04 |
| 18 | 上传链与 journal 拉进 M0,与 09 冲突未标注(09 自身清单/验收句矛盾) | 按 09 验收句取齐,标注偏差,回写 09 | 00;docs/09 |
| 19 | `_index/people.json` 矩阵必带却无写入路径;`_incoming`/`_probe` 矩阵无行 | 建档五步含重写 people.json;矩阵补 `_incoming/**`、`_probe/**` 两行 | 06 §1;docs/04 §1 |

capture.json 形状变化(+capture_date)裁决:尚无任何已产对象,版本号维持 2.0,**docs/04 §3 示例回写**为与 contracts 一致;contracts 是 sidecar schema 的唯一权威,docs 示例是说明性的(已在 docs/04 注明)。

## B 档(实现注记,已并入各 spec 的「实现注记」小节)

advisory lock=`pg_advisory_xact_lock(hashtextextended(key,0))`;journal 分片按事件 `at` 的 UTC 月;幂等判等=canonical 序列化比对;presign 无幂等键(接受浪费,lifecycle 兜底);pages≤99;`<qkey>` BNF 补全(M0 不实现 audio 构造);时间戳:capture.json 存客户端原文,服务端生成一律 `YYYY-MM-DDTHH:mm:ss.SSSZ`;JWT leeway 60s + alg 白名单 HS256;限流固定窗口/单实例内存/429;时延不可区分降级为"不做显式区分,非验收项";mime 精确小写匹配、忽略参数;Uuid 强制小写、IsoDate 校验真实日历日;original_filename 持久化自 presign,page 的 mime/byte 以 HeadObject 实测为准;③ 错误路径逐条定码;registries 文件名=部署日、同日幂等覆盖;compose 显式配 MinIO KMS(否则 A1 加密断言仅生产执行);探针断言清单入 04 §2;A10 字段表穷尽化 + 脚本名;HEIC 由人工预转 JPEG;路由校验用 `defineRoute` 包装器 + CI grep 禁裸注册;encounter 最小 schema 入 contracts;status=`ready` 落库标注偏差(07 示例是 uploaded);exif M0 缺省可空;短 ID 预留即查重(upload_batch.doc_short_id UNIQUE)。

## C 档(登记设计债 / 显式接受)

- **D11(新)**:权限授予/文档删除的系统级审计(`_index/audit/`)M1 落地 —— M0 的 owner 自动授予可从 journal 推导,显式接受
- **D12(新)**:JWT 无吊销 + argon2 参数无版本标记 —— M1 前给出吊销与参数迁移方案
- capture_date 用上传者时区的跨账号后果:已在 03 §3 记录为已知权衡,key 永不变,禁止未来当 bug "修"
- `_meta/README.md` 属重写式 → 回写 docs/04 矩阵单列
- 02 "不建"清单补 report_narrative;`document.status` 的 uploading/uploaded/failed 建而不用注明
- delete marker 使 If-None-Match 失效的边缘:应用凭证无 delete 权限,记入 04 已知边界
- person_identifier 全局唯一(跨 person)是否有意 —— M1 前确认(家人共用就诊卡场景)
