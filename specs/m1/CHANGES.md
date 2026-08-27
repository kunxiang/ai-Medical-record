# M1 spec 实现期变更记录(specs/README 硬约定 4)

| # | 日期 | 变更 | 理由 |
|---|---|---|---|
| 1 | 2026-08-18 | 派生物端点(`/thumb`、`/preview`)额外接受 `?access_token=<jwt>` 查询参数作为 Bearer 头的替代(01 §B2 / 02 §2) | 实现期发现的**规范矛盾**:审核 #002 A-9 把接口改为 302 是为了让 `<img loading="lazy">` 的原生懒加载生效,但 `<img>` 无法携带 `Authorization` 头 —— 两个要求不能同时满足。裁决:只在这两个只读端点开查询参数口子。缓解:①同源请求,无跨站 referrer 泄露;②302 目标是 300 秒预签名 URL;③token 本就存在 localStorage(05 §2 已显式取舍);④**D12 已在 M1 落地**,泄露后改密码即可全局失效。其余端点一律只接受 Bearer 头。 |
| 2 | 2026-08-18 | 桶 CORS 的配置方式按存储实现分流:AWS S3 走 `PutBucketCors`;**MinIO 未实现该 API(501)**,改由 `MINIO_API_CORS_ALLOW_ORIGIN` 环境变量提供。自检从"读回 GetBucketCors 比对配置"改为"**发真实 preflight 验证行为**"(02 §7.2) | 验收实证:MinIO 对 `PutBucketCors` 返回 `501 NotImplemented`。行为自检比配置自检更强 —— 它验证的是"浏览器能不能直传",而不是"我们写了什么配置",且对两种实现同样有效。 |
| 3 | 2026-08-18 | tools 的 S3 客户端加 MinIO 兼容中间件:桶配置类请求剥掉 flexible checksum 头、补 `Content-MD5`,且**必须在 `build` 步**(finalizeRequest 里签名已完成,此后加的头不进签名 → AccessDenied) | 新版 AWS SDK 对 lifecycle/versioning 等强制附加 CRC32 校验和,MinIO 只接受 Content-MD5 → 501。对象上传的 `ChecksumSHA256` 语义不受影响。 |
| 4 | 2026-08-18 | 新增 `capture_discard_event` 台账(迁移 0002),放弃上报按 `discard_event_id` 服务端幂等;`appendJournal` 不再覆盖调用方传入的 `event_id` | 验收实证:m1-99 A8 要求"重复上报同一 `discard_event_id` 只产生一行",而原实现既丢弃了客户端的幂等键、又无任何服务端去重。台账是 L2 结构,重建后的重放窗口记为 D17。 |
| 5 | 2026-08-18 | `POST /documents` 的幂等比对改用 `idempotencyFingerprint`(原为整包 canonical payload);`rebuild-index` 从 capture.json 重算该指纹存入 `column_set.idem_fingerprint` | 审核 #002 A-1 的修复函数写进了 contracts 却没有接线,API 仍在比对整包 —— 重试必然重新 presign、`batch_id` 必变 ⇒ 每次重试都 409 终止。指纹的每个输入都是 L1 事实,故重建可原样重算,不引入新的不可重建状态。 |
| 6 | 2026-08-18 | `pauseAt` 由"抛错"改为 §0.1 写明的"挂起,不推进";`verify-rebuild` 的字段表移除 `thumb_key`(m1-99 A19) | 抛错会让队列自行把状态清理干净,A5 的崩溃恢复路径因此从未被真正测到。`thumb_key` M1 不写,比对恒为 null 的列只制造噪声。 |
| 7 | 2026-08-26 | 人员选择器补接 M0 `POST /people`，新增家庭成员建档、自动切换与精简缓存更新；验收新增 A1b | 原 A1 先用 API 建档再打开 PWA，只证明“已有人员可以选择”，没有覆盖用户从界面创建家庭成员，导致 M0 能力在 M1 产品中不可达。 |
