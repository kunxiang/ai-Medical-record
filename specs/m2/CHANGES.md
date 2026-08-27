# M2 spec 变更记录(specs/README 硬约定 4)

| # | 日期 | 变更 | 理由 |
|---|---|---|---|
| 1 | 2026-08-18 | 审核 #003 的 8 项 A 档裁决已全部回写(02/04/05/06/01/99) | 见 [review-003.md](./review-003.md) |
| 2 | 2026-08-18 | 修正审核 #003 A1 的表述并细化裁决:`client.beta.messages.parse()` **确实存在**且能与 `betas`/`fallbacks` 共存(A1 原文称"在非 beta 命名空间"不准确)。裁决结论不变 —— 仍用 `create()` + 自行校验,但**理由改为"注入点必须落在 wire 边界"**:`parse()` 在 SDK 内做客户端解析,注入点放它之上会让录制盒存的是 SDK 加工过的产物,回放证明不了对真实响应的处理是对的。同时更正助手名为 `betaZodOutputFormat`。 | 实现期核实 SDK 0.70.1 的类型定义 |

| 3 | 2026-08-18 | **审核 #004 的 19 项 A 档全部回写**,成体系修订而非零散打补丁:新增 [07-replay.md](./07-replay.md);重写 [01-contracts-delta.md](./01-contracts-delta.md);02/03/04/05/06/99 逐条改正;D16 绑定由 M3 上调至 M2;新增设计债 D20/D21 | 见 [review-004.md](./review-004.md)。四条互相咬合(journal 回放 / decisions 落点 / `event_time` 复用 / split 的 L1 载体),必须一起改 |

| 4 | 2026-08-21 | 部署测试期实测推翻 ADR-048 的一条结论:R2 的预签名 PUT **可以**携带 `x-amz-checksum-sha256`(需 `unhoistableHeaders`),且错误摘要被 `400 BadDigest` 拒绝。原"改签 Content-MD5 + 服务端重算 sha256"的后果 1 取消 | 探针漏了 `unhoistableHeaders`,而产品代码 `presignPut` 从 M0 起就一直传了它 —— 我用一条跟产品不同的调用路径去"验证"能力,验到的是两条路径的差异 |
| 5 | 2026-08-26 | 实现期补齐 `document.facility_name_raw` 这一 L2 可重算列；Stage 1 写入该列，facility handler 才能按同一指纹批量回填全部未归一文档 | `05 §2.2` 规范性要求按 `facility_name_raw` 指纹批量回填，但 `01 §5` 的列清单与迁移 `0003` 漏列，且 `ai_job` 无 payload；不补该列就无法从现有 DB 状态确定性执行 |
| 6 | 2026-08-26 | `normalization_decision` 增加唯一、可空的 `client_operation_id`，facility proposal 同步保存模型 `confidence` 与 `reason` | 确认/拒绝接口必须用客户端操作 ID 保证重试幂等；人工审核与 L1 回放还必须保留当时的判断依据，不能只记录最终机构行 |
| 7 | 2026-08-26 | 新增 L2 `human_operation` 幂等缓存，按 `client_operation_id` 保存人工操作请求与首次响应 | archive/ack/reassign/boundary 都会追加不可删除的 L1 事件；仅靠业务表最终状态无法区分“同请求重试”和“冲突的新操作”，必须有统一台账。该表可由 L1 回放恢复，不是权威事实 |
| 8 | 2026-08-26 | 归人纠正后写 `person_check_ack_at` 并清空 S1 工件锚点，不写已从枚举删除的 `person_check='skipped'` | `06 §2.5` 残留旧表述，与 `01 §2/§5` 和 `05 §1.4–§1.6` 的最终裁决冲突；L2 `person_check` 仍可重算，L1 ack 才能在重跑后持续抑制旧告警 |
| 9 | 2026-08-26 | split 新文档使用新 `short_id` 的元数据目录并写独立 `capture.json`；`pages[].file` 以完整 key 引用源原件 | 审核 #004 A-12′ 同时要求“prefix=源目录”和“新文档自己写 `capture.json`”，在 WORM 唯一 key 下不可同时实现。新元数据目录既保住每文档一份 capture 的重建不变式，也不复制或移动任何原件字节 |
| 10 | 2026-08-26 | S1 prompt 升至 v2，明确区分图像的显式页号与 PDF 内部物理页序；API 复用既有 `pdf-lib` 做 32 MiB / 600 页服务端门禁 | 原 v1 prompt 只描述图像并要求“页号已经给出”，与 PDF document block 没有外部页号的输入形态冲突；仅改请求 user text 无法覆盖 system 中的旧硬性要求 |
| 11 | 2026-08-26 | 16k `max_tokens` 截断后的 32k 提额调用改走 SDK `messages.stream().finalMessage()`，录制/回放 transport 同时覆盖流式路径 | 落实审核 #004 A-8；显式 600 秒 timeout 会关闭 SDK 的非流式长请求守卫，32k 非流式调用预期超时且会产生重复计费 |
| 12 | 2026-08-26 | `POST /uploads/presign` 对 `>8 MiB` 文件只返回 `mode='multipart'` 与空 URL；新增 `multipart_upload` L2 台账和 `upload_file.multipart_verified_at`，只有 complete 后 GET 回流整文件校验通过才允许登记 | 若仍下发单 PUT URL，客户端或旧版本可绕过强制 multipart；若仅依赖 S3 multipart ETag/复合 checksum，无法证明合并对象与客户端申报的原始 SHA-256 一致。持久化校验锚点同时让登记重试不必再次下载临时对象 |

> ⚠️ 审核 #003 **不满足** docs/10 §1 的"≥2 个独立对抗视角" —— 本会话配置禁止在未获用户请求时启用子代理,故由 spec 作者本人以两个对抗视角复核。作者复核能抓内部矛盾与事实错误(A1–A5 皆属此类),但对"没想到的角度"天然失效。**建议实现开工前补一轮真正独立的审核。**
