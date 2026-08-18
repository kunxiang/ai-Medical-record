# M1 spec 实现期变更记录(specs/README 硬约定 4)

| # | 日期 | 变更 | 理由 |
|---|---|---|---|
| 1 | 2026-08-18 | 派生物端点(`/thumb`、`/preview`)额外接受 `?access_token=<jwt>` 查询参数作为 Bearer 头的替代(01 §B2 / 02 §2) | 实现期发现的**规范矛盾**:审核 #002 A-9 把接口改为 302 是为了让 `<img loading="lazy">` 的原生懒加载生效,但 `<img>` 无法携带 `Authorization` 头 —— 两个要求不能同时满足。裁决:只在这两个只读端点开查询参数口子。缓解:①同源请求,无跨站 referrer 泄露;②302 目标是 300 秒预签名 URL;③token 本就存在 localStorage(05 §2 已显式取舍);④**D12 已在 M1 落地**,泄露后改密码即可全局失效。其余端点一律只接受 Bearer 头。 |
| 2 | 2026-08-18 | 桶 CORS 的配置方式按存储实现分流:AWS S3 走 `PutBucketCors`;**MinIO 未实现该 API(501)**,改由 `MINIO_API_CORS_ALLOW_ORIGIN` 环境变量提供。自检从"读回 GetBucketCors 比对配置"改为"**发真实 preflight 验证行为**"(02 §7.2) | 验收实证:MinIO 对 `PutBucketCors` 返回 `501 NotImplemented`。行为自检比配置自检更强 —— 它验证的是"浏览器能不能直传",而不是"我们写了什么配置",且对两种实现同样有效。 |
| 3 | 2026-08-18 | tools 的 S3 客户端加 MinIO 兼容中间件:桶配置类请求剥掉 flexible checksum 头、补 `Content-MD5`,且**必须在 `build` 步**(finalizeRequest 里签名已完成,此后加的头不进签名 → AccessDenied) | 新版 AWS SDK 对 lifecycle/versioning 等强制附加 CRC32 校验和,MinIO 只接受 Content-MD5 → 501。对象上传的 `ChecksumSHA256` 语义不受影响。 |
