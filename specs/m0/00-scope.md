# M0 Spec · 00 范围

> 里程碑目标(09):**能把一张照片安全地存进去,并且五年后还能读。**
> 依据的设计文档:01(技术栈)、02(仓库结构)、03(数据模型 §1–3)、04(存储布局)、07(API §0–2)、ADR-008/009/041/045。

## 1. 交付物

| # | 交付物 | 规范 |
|---|---|---|
| 1 | Monorepo 骨架(pnpm workspace) | 本文件 §3 |
| 2 | `packages/contracts` 首版 | [01-contracts.md](./01-contracts.md) |
| 3 | PostgreSQL schema + Drizzle 迁移 | [02-db-schema.md](./02-db-schema.md) |
| 4 | `packages/storage`:key/slug/sidecar | [03-storage-keys.md](./03-storage-keys.md) |
| 5 | S3 桶创建与配置 + `_meta/` 落桶 | [04-bucket-config.md](./04-bucket-config.md) |
| 6 | 认证 + `person_access` 中间件 | [05-auth.md](./05-auth.md) |
| 7 | 建档 API + 最小上传链 | [06-api-m0.md](./06-api-m0.md) |
| 8 | 验收 | [99-acceptance.md](./99-acceptance.md) |

`[偏差:vs 09 —— 09 的 M0 清单不含上传与 journal,但其验收句要求"上传一张图";按验收句取齐,且 D1 原则要求 journal 随建档同里程碑。已回写 09。]` 审核记录见 [review-001.md](./review-001.md)。

## 2. 明确不做(M0 边界)

- **无任何 AI 调用**。分类、提取、归人对账都是 M2+。
- **无 PWA/前端**。验收全部走 curl / 脚本。
- **无离线队列**(M1)、无问答(M3)、无提取(M4+)、无 observation/趋势(M5+)。
- **无 encounter 逻辑**:仅建表(02-db-schema),无 API、无归组。
- **无缩略图/预览**(M1)。`derived/` 前缀在 M0 保持为空。
- **无批量导入路径**:`status = needs_person_confirm` 不可达,M0 上传必须 `person_confirmed: true`。
- **无归人纠正/对账**:`person_mismatch` 是 M2;`correction-NNNN.json` 的 schema 已在 [03 §4](./03-storage-keys.md) 定义并落 `_meta/schemas/`,M0 无写入路径。
- **journal 事件在 M0 只有 `person_update` 一种**(建档/改档触发)。事件注册表机制必须落地,后续里程碑只加条目。

## 3. 工程约定(骨架)

- **运行时**:Node ≥ 22 LTS,ESM only。包管理 pnpm ≥ 9,workspace 布局按 02(`apps/api`、`apps/web` 占位、`packages/contracts`、`packages/storage`;`packages/medical` M0 不建)。
- **TypeScript**:`strict: true`,`noUncheckedIndexedAccess: true`。禁止 `any` 出现在 `packages/*` 的导出签名中。
- **依赖规则**(02 §2)从 M0 起 CI 强制:`packages/*` 禁止依赖 `apps/*`;`contracts` 零运行时依赖(仅 `zod`)。
- **测试**:vitest。`packages/storage` 的 key/slug/sidecar 必须有往返(round-trip)性质测试。
- **本地环境**:`infra/docker-compose.yml` 提供 PostgreSQL 16 + MinIO(启用 versioning 与 object lock 的 S3 兼容实现,作为开发/CI 用桶)。CI 亦跑在该 compose 上。
- **时间**:服务端一律存 UTC(timestamptz);仅 key 中的 `capture_date` 按 §[03-storage-keys](./03-storage-keys.md) 规定的时区规则折算。

## 4. M0 的验收哲学

M0 交付的是**第一层(L1)的地基**。所以验收里最重的不是 API 通,而是 ADR-045 的性质在最小场景下成立:

1. 上传一张图后,桶里的每个对象都能在 [04 §1 权威矩阵](../../docs/04-storage-layout.md) 里找到自己的行(含 `_incoming/`、`_probe/`,矩阵已回写);
2. 删掉数据库,仅凭桶(+ seed 账号)重建出等价的 person 与 document 记录 —— 等价性按 99 A10 的穷尽字段表,account/person_access 显式在外;
3. WORM 的真实语义成立:**版本不可销毁** + 应用条件写纪律(versioning 下裸 PUT 仍会产生新版本 —— 验证命令见 04-bucket-config §4)。
