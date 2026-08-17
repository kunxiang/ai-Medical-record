# M0 Spec · 99 验收清单

全部在 `infra/docker-compose.yml`(PG16 + MinIO)环境执行。`pnpm m0:acceptance` 一键跑完 A 组;B 组是 CI 断言;C 组人工跑一次留档。

## A. 端到端(自动化脚本)

| # | 步骤 | 断言 |
|---|---|---|
| A1 | `provision-bucket` 幂等跑两次 | 第二次无变更退出 0;04 §1 的 5 条验证命令全过 |
| A2 | `_meta/` 落桶 | schemas 覆盖代码中出现的每个 `schema_version`;README 存在 |
| A3 | seed 账号 + login | 拿到 JWT;错密码 401 且响应体与"用户不存在"完全一致 |
| A4 | 建档(含过敏史+identifier) | 响应含 slug;S3 出现 `_person.json`(含 identifiers)与 journal `person_update` 行 |
| A5 | presign → PUT 直传 → POST /documents | 200;`rclone ls` 看到 `people/{slug}/{yyyy}/{date}__{dslug}/` 下 page-01.jpg、page-01.json、capture.json;manifests 出现 add 行 |
| A6 | capture.json 内容 | `.strict()` 校验过;**不含** doc_type/facility/summary 键;capture_date 符合 03 §3 折算 |
| A7 | WORM | 对 capture.json 与 page-01.jpg:覆盖被拒、无特权删除被拒(04 §4 命令) |
| A8 | 幂等矩阵 | 06 §3 三行全过 |
| A9 | 越权 | B 账号访问 A 的 person/document/页 URL → 全部 404;viewer 写 → 404 |
| A10 | **重建演练(M0 最小版)** | `dropdb` → `tools/rebuild-index` 仅凭桶(manifests + capture.json + _person.json + journal)重建 → person/document/document_page 行数与关键字段(slug、short_id、sha256、过敏史)与删库前一致 |
| A11 | 归档 | DELETE person → 列表不可见、直访 404、S3 原件原样在 |

## B. CI 断言(每次提交)

| # | 断言 |
|---|---|
| B1 | 依赖规则:`packages/*` 不 import `apps/*`;contracts 仅依赖 zod |
| B2 | DB CHECK 枚举 == contracts 枚举(生成物比对) |
| B3 | 迁移从零重放成功 |
| B4 | storage 性质测试(03 §6)全过,key 往返 ≥1000 例 |
| B5 | journal 并发追加 2×100 行 → 恰 200 行 |
| B6 | sidecar canonical 序列化字节级可重现 |
| B7 | tsc strict 零错误;api 路由全部挂 contracts 校验(lint 规则) |

## C. 一次性人工验收(留档进 `specs/m0/RESULTS.md`)

| # | 内容 |
|---|---|
| C1 | 治理模式特权绕过:离线凭证删探针对象成功;应用凭证 IAM 无 BypassGovernanceRetention |
| C2 | 真实手机照片(≥3 MB HEIC→JPEG)走通 A5 全链 |
| C3 | 用与本项目无关的通用 S3 浏览工具打开桶,不看代码,5 分钟内根据 `_meta/README.md` 找到那张照片并说出它是谁、何时拍的 —— **这是 ADR-008 的"五年后可读"在 M0 的代理测试** |

## 完成定义

A + B 全绿,C 留档,`specs/m0/RESULTS.md` 记录执行日期与产物 → M0 关闭,进入 M1 spec。
