# M0 验收结果

执行:2026-08-18,开发/CI 环境(docker compose:PG16 + MinIO RELEASE.2025-09,逐对象锁与条件写探针全过)。
执行方式:`pnpm m0:acceptance`(infra/run-m0.sh:清场 → compose → MinIO 应用用户/策略 → 迁移 → provision → _meta → seed → 双 API 实例 → A 组 → B 组)。

## A 组(端到端自动化):53/53 全绿

A1 建桶幂等与配置自检 ✓ · A2 `_meta`(schemas×6/registries/README)✓ · A3 登录/401 字节级一致/429 限流 ✓ · A4 建档五步(_person.json 含 id+identifiers+过敏史、journal 双写含 event_id)✓ · A5/A6 上传链(最终目录三件套、manifests add、_incoming 清空、capture.json 无 AI 观点、capture_date 折算、快照语义)✓ · A7 WORM 真实语义(条件 PUT 412、裸 PUT 出新版本、原版本锁拒删、可恢复)✓ · A8 幂等与崩溃矩阵(after-copy/after-sidecar 注入 → 续跑 201 → 重放 200 → 异 payload 409 → 批次复用 409)✓ · A9 越权全 404 且与不存在不可区分 ✓ · A10 **删库重建等价性**(穷尽字段比对;注入重复 event_id 与幽灵 add 行 → 无幽灵入库、对账报告有记录)✓ · A11 归档(死档不复活)✓ · A12 Merge Patch 安全(单字段 PATCH 过敏史不动、显式 null 置空)✓ · A13 拒绝路径(422/413/409/400)✓ · 矩阵覆盖扫描(桶内对象 ⊆ 权威矩阵)✓

## B 组(CI 断言):全过

B1 依赖规则 ✓ · B2 迁移 CHECK == contracts 枚举 ✓ · B3 迁移从零重放 ✓ · B4 storage 性质测试(key 往返 1100 例 + 模糊)✓ · B5 双 API 进程并发 100 次 PATCH → journal 恰 +100 行 ✓ · B6 canonical 字节级可重现 ✓ · B7 defineRoute 强制(无裸注册)✓ · B8 schema_version ⊆ _meta ✓ · B9 回放幂等(A10 注入覆盖)✓

## C 组(人工,一次性)

| # | 结果 |
|---|---|
| C1 | ✅ 2026-08-18 执行:应用凭证 + `BypassGovernanceRetention` 删被锁版本 → **AccessDenied**;特权凭证同命令 → 成功。治理模式语义与权限隔离双向验证。 |
| C2 | ⏳ 待项目所有者:真实手机照片(HEIC 人工预转 JPEG)走通 A5 全链 |
| C3 | ⏳ 待项目所有者:请一位与本项目无关者用通用 S3 工具 + `_meta/README.md`,5 分钟内找到该照片并说出人名与拍摄日期(判据与用时记录于此) |

## 验收期实证修复(全部已回写 spec/CHANGES)

1. 探针 key 按实例隔离(CHANGES #2)—— 双实例并发启动互撞
2. 验收必须洁净环境起跑(run-m0.sh 强制 down -v)
3. 崩溃续跑采纳既有 capture.json 为权威(document_id/created_at)—— 否则重试字节必不同
4. 幂等命中降 200(defineRoute setStatus)
5. **person 级 advisory lock**(CHANGES #3)—— 并发编辑下 `_person.json` 不按提交序落桶,重建不等价;这是 A10×B5 组合抓到的真实一致性缺陷
6. rebuild 的 jsonb 参数须 `sql.json()`(文本绑定被双重编码)
7. drizzle 迁移记录表在独立 schema,重建演练 drop 需一并清除

## 结论

A + B 全绿,C1 完成,C2/C3 待项目所有者执行后 M0 关闭。
