# M0 spec 实现期变更记录(specs/README 硬约定 4)

| # | 日期 | 变更 | 理由 |
|---|---|---|---|
| 1 | 2026-08-17 | `capture.json` 增加 `client_document_id` 与 `original_filename` 两键(03 §4 / contracts CaptureSidecar) | 实现 A10 时发现:99 的重建等价字段表要求二者一致,但桶内没有它们的落点。二者均为**上传瞬间已知的事实**,按 ADR-045 判据("上传瞬间就知道的进 capture.json")本就该在 —— 首版 spec 遗漏。schema_version 维持 2.0(尚无已产对象)。 |
| 2 | 2026-08-18 | 探针 key 允许实例后缀:`_probe/(startup|lock-probe)(-[a-z0-9]{1,16})?`(04 §3 / key BNF) | 验收实证:双 API 实例并发启动时,共享 `_probe/startup` 使 B 实例的 If-None-Match 首放断言 412,进程按设计拒启。探针必须按实例隔离。 |
