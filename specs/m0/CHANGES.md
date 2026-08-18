# M0 spec 实现期变更记录(specs/README 硬约定 4)

| # | 日期 | 变更 | 理由 |
|---|---|---|---|
| 1 | 2026-08-17 | `capture.json` 增加 `client_document_id` 与 `original_filename` 两键(03 §4 / contracts CaptureSidecar) | 实现 A10 时发现:99 的重建等价字段表要求二者一致,但桶内没有它们的落点。二者均为**上传瞬间已知的事实**,按 ADR-045 判据("上传瞬间就知道的进 capture.json")本就该在 —— 首版 spec 遗漏。schema_version 维持 2.0(尚无已产对象)。 |
| 2 | 2026-08-18 | 探针 key 允许实例后缀:`_probe/(startup|lock-probe)(-[a-z0-9]{1,16})?`(04 §3 / key BNF) | 验收实证:双 API 实例并发启动时,共享 `_probe/startup` 使 B 实例的 If-None-Match 首放断言 412,进程按设计拒启。探针必须按实例隔离。 |
| 3 | 2026-08-18 | person 变更事务必须以 person 粒度 advisory lock 开场(03 §5.4 扩展;`pg_advisory_xact_lock('person:'+id)`) | 验收 A10×B5 实证:journal 追加有锁但 `_person.json` 重写不按提交序落桶 —— 并发编辑后桶内快照停在中间版本,重建不等价。五步原子的"原子"必须覆盖 S3 重写顺序。 |
| 4 | 2026-08-18 | **幂等比对口径**由"整个 DocumentCreate 的 canonical 字节"改为**稳定语义子集**(排除 `batch_id`/`upload_id`/`exif`),由 contracts 导出 `idempotencyFingerprint()`(m0-06 §3) | M1 审核 #002 A-1:M1 规定"每次重试重新 presign",而旧口径把 `batch_id` 算进 payload ⇒ 任何"服务端已提交但客户端未收到 2xx"的重试都会 409 终止,用户被告知永久失败而文档其实已建好。同时废掉 m0-04 §8 的"多标签由幂等键兜底"承诺。 |
| 5 | 2026-08-18 | `DocumentCreate` 增 `confirmed_by`(默认 `api`),服务端原样落 `capture.json.person.confirmed_by`(m0-01 §4 / m0-03 §4) | `capture_ui` 枚举值的存在意义就是记录 ADR-041 核心断言;M0 无 UI 只能写 `api`,M1 是第一个能产生该事实的里程碑。对象锁 10 年,写错即永久失真。 |
| 6 | 2026-08-18 | `PageIn` 与 `capture.json.pages[]` 增 `capture_order` 与 `exif{captured_at, orientation}`(m0-01 §4 / m0-03 §4) | `capture_order` 是拍摄瞬间即知的 L1 事实(ADR-047:key 中的 NN 恒为拍摄序,M2 后 `page_no` 可分离);`exif` 勾销 m0-03 §4 "M1 采集端补"的欠账,且 `DateTimeOriginal` 决定 `capture_date` —— 相册导入的旧单据若记成今天会永久错档。 |
| 7 | 2026-08-18 | `parseKey` 补 `derived/` 三类匹配(meta/thumb/preview)(m0-03 §2) | M0 已有 `buildKey.derivedMeta` 却无对应 MATCHERS 项,`parseKey` 遇 derived key 直接抛 —— 矩阵覆盖扫描会误报。 |
| 8 | 2026-08-18 | 桶 CORS 规则进 `provision-bucket` 与其自检(m0-04 §1 的"M1 采集端上线时补") | 带 `x-amz-checksum-sha256` 的跨源 PUT 必触发 preflight;桶无 CORS = 浏览器直传第一跳即死。 |
| 9 | 2026-08-18 | `GET /people` 分页由"M1 补"改绑 **M4**(m0-01 §4) | 个人档案人数恒为个位数,分页无收益;M4 检索里程碑统一处理列表分页。 |
