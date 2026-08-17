# M0 Spec · 99 验收清单

审核 #001 修订。全部在 `infra/docker-compose.yml`(PG16 + MinIO(含 KMS))执行。`pnpm m0:acceptance` 一键跑 A 组;B 组 CI 每提交;C 组人工一次留档 `specs/m0/RESULTS.md`(含模板:执行人、日期、逐项结果、C3 用时)。

## A. 端到端(自动化脚本)

| # | 步骤 | 断言 |
|---|---|---|
| A1 | `provision-bucket` 幂等跑两次 | 第二次无变更退出 0;04 §1 全部验证命令过(加密断言开发环境依 KMS 配置降级) |
| A2 | `_meta/` 落桶 | schemas 覆盖代码中每个 `schema_version`;registries 当日文件存在;README 存在 |
| A3 | seed 账号 + login | 拿到 JWT;错密码与不存在的邮箱 → 401 且响应体字节级一致;11 次连发 → 第 11 次 429 |
| A4 | 建档(含过敏史 + identifier) | 响应含 slug;S3:`_person.json`(含 id/identifiers)、`_index/people.json` 更新、journal person_update 行(含 event_id) |
| A5 | presign → PUT 直传 → POST /documents | 200;`rclone ls`:最终目录含 page-01.jpg / page-01.json / capture.json;manifests add 行;`_incoming` 临时对象已删 |
| A6 | capture.json 内容 | `.strict()` 过;无 doc_type/facility/summary 键;capture_date 折算正确;person.name 为登记时快照 |
| A7 | WORM(按 04 §4 真实语义) | 条件 PUT → 412;裸 PUT 成功但原版本在且带锁、删原版本 → AccessDenied;应用凭证 IAM 无 BypassGovernanceRetention / 无 L1 DeleteObject |
| A8 | 幂等与崩溃矩阵 | 06 §3 全部 6 行(崩溃注入:在步骤 4/5/6 后 kill 进程再重试) |
| A9 | 越权 | B 账号访问 A 的 person/document/页 URL → 404 且与"不存在"响应一致;viewer 写 → 404 |
| A10 | **重建演练** | 流程:`dropdb` → `seed-account` → `tools/rebuild-index`(输入:manifests + capture.json + `_person.json` + journal,按 event_id 幂等回放)→ 比对脚本 `tools/verify-rebuild.ts` 按**穷尽字段表**比对:person(id、slug、全部 PersonFields、archived_at、identifiers 逐行)、document(id、short_id、person_id、capture_date、captured_at、source、original_filename、status、client_document_id)、document_page(全列)。**排除**:account、person_access(重建后由 seed + 手工授权恢复,显式边界)。注入测试:重复 event_id 行、无 capture.json 佐证的 add 行 → 重建无幽灵 + 对账报告有记录 |
| A11 | 归档 | DELETE person → 列表不可见、直访 404、原件在;**再跑 A10:归档状态保持**(不复活) |
| A12 | PATCH 安全 | 只改 display_name 的 PATCH → 过敏史/identifiers/其余字段逐字段不变;显式 `"blood_type": null` → 置空 |
| A13 | 拒绝路径 | 非白名单 mime → 422;登记 byte_size 与实际不符 → 413;伪造 sha256 → 409;过期批次 → 422;跨批次 upload_id → 400;二次消费批次 → 409 |

## B. CI 断言(每次提交)

| # | 断言 |
|---|---|
| B1 | 依赖规则:packages 不 import apps;contracts 仅依赖 zod |
| B2 | DB CHECK 枚举 == contracts 枚举(生成物比对,含 encounter_type) |
| B3 | 迁移从零重放成功 |
| B4 | storage 性质测试(03 §6)全过:slug、key 往返 ≥1000、canonical、模糊测试 |
| B5 | journal 并发:两进程走应用写路径各追加 100 行 → 恰 200 行 |
| B6 | canonical 序列化字节级可重现(含 schema_version 居首断言) |
| B7 | tsc strict 零错误;全部路由经 `defineRoute` 注册(CI grep 无裸注册) |
| B8 | 代码中每个 `schema_version` 在 `_meta/schemas/` 源目录有对应文件(D10) |
| B9 | 回放幂等单测:重复 event_id / 无佐证 add / 乱序行 |

## C. 一次性人工验收(留档)

| # | 内容 |
|---|---|
| C1 | 治理绕过:离线凭证 `--bypass-governance-retention` 删 `_probe/lock-probe` 成功;应用凭证同命令失败 |
| C2 | 真实手机照片(≥3 MB,HEIC 由人工预转 JPEG,任意工具)走通 A5 全链 |
| C3 | 与本项目无关者用通用 S3 浏览工具 + `_meta/README.md`,5 分钟内找到该照片并说出 display_name 与拍摄日期(判据:两项全对 + 用时 ≤ 5 分钟,记录在 RESULTS.md) |

## 完成定义

A + B 全绿,C 留档 → M0 关闭,进入 M1 spec。**桶内对象 ⊆ 权威矩阵行**由 A5+A1 联合保证(A 组结束后脚本 `list-objects` 全量扫描,逐 key 匹配矩阵前缀规则,发现矩阵外对象即失败)。
