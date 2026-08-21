# 11 · 部署

> 本文档描述**部署测试**所需的最小可用部署。生产加固(备份、监控、恢复演练)见 09 的 M8。

## 0. 当前可部署的范围

| 能力 | 状态 |
|---|---|
| 采集管道(拍照/相册/PDF → 离线队列 → 上传 → 归档) | ✅ M1 已验收(88/88) |
| 浏览(按人 → 时间轴 → 缩略图/预览) | ✅ M1 |
| AI 元数据(S1 分类/日期/机构 + 归人对账) | 🚧 M2 进行中:队列、S1 落库、归人对账已可运行;归一/归组/回放/纠正未完成 |
| 情境问答 / 检索 / 趋势 / 导出 | ❌ M3+ |

**部署测试的目标是验证 M1 那条链路在真实环境里成立**,M2 的部分以"能跑起来、不阻断"为准。

## 1. 组件与依赖

```
┌─────────────┐   HTTPS    ┌──────────────┐
│  PWA(静态)│──────────>│  API(Node)  │
└──────┬──────┘            └───────┬──────┘
       │  预签名直传                │
       │                            ├──> PostgreSQL 16
       └────────────────────────────┴──> 对象存储(S3 兼容)
```

- **PWA**:`apps/web` 构建产物,纯静态。**必须** HTTPS —— 非安全上下文下 `crypto.subtle`、Service Worker、Web Locks、StorageManager 全部不可用,采集链路直接失效。
- **API**:`apps/api`,Node 22+。
- **PostgreSQL 16**。
- **对象存储**:S3 兼容。能力要求见 §3。

## 2. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | |
| `AUTH_SECRET` | ✅ | **≥32 字节**,否则拒绝启动 |
| `S3_ENDPOINT` | ✅ | R2 为 `https://<account>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | ✅ | |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | ✅ | 运行时只需**对象级**权限(Put/Get/Head/Copy/Delete + List) |
| `S3_REGION` | — | R2 自动推断为 `auto`;显式设置优先。**签名区域不匹配会直接 `SignatureDoesNotMatch`,而错误信息完全不提区域** |
| `S3_PUBLIC_ENDPOINT` | — | 容器内外 endpoint 不同时用 |
| `WEB_ORIGIN` | ✅ | 逗号分隔。**禁止 `*`** —— 带 `Authorization` 的跨源请求需要精确 origin |
| `PORT` | — | 默认 8300 |
| `AI_JOB_CONCURRENCY` | — | 默认 2 |
| `AI_JOB_WORKER` | — | `0` 关闭作业轮询器(验收时用) |
| `ANTHROPIC_API_KEY` | M2 起 | 不配则 S1 作业失败进 `needs_human`,不影响采集与浏览 |

PWA 构建期变量:`VITE_API_BASE`(API 的对外地址)。**禁止**设 `VITE_M1_TEST_HOOKS`。

## 3. 对象存储的能力要求

**硬性(缺则不可用):**

| 能力 | 用途 |
|---|---|
| 条件写 `If-None-Match` / `If-Match`(返回 412) | L1 仅创建写、JSONL 追加的并发防御。**这是本项目并发模型的地基** |
| 预签名 PUT | 浏览器直传 |
| `CopyObject` | `_incoming` → 最终 key 的搬运 |
| CORS | 跨源直传;`AllowedHeaders` 漏一个就是整条链死 |

**可选(缺则降级,启动时如实播报):**

| 能力 | 缺失时 |
|---|---|
| 逐对象保留锁(GOVERNANCE) | WORM 不由服务端强制,须落实 ADR-048 的三条补偿 |
| 对象版本化 | 覆盖不可回滚 |

**换后端前先跑能力探针**,不要先跑迁移:

```bash
S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY=... S3_SECRET_KEY=... \
  pnpm --filter @amr/tools probe-storage
```

R2 的实测结论见 ADR-048:条件写完整可用;预签名 PUT 带 sha256 校验和完全可用且真强制;**无版本化、无逐对象保留锁**(均 501)。

## 4. 首次部署

```bash
# 1) 构建
pnpm install --frozen-lockfile
pnpm -r build

# 2) 数据库
DATABASE_URL=... pnpm --filter @amr/api db:migrate

# 3) 桶配置(需 **admin 档**存储凭证;配完即可降回对象级)
S3_ENDPOINT=... S3_BUCKET=... S3_ADMIN_KEY=... S3_ADMIN_SECRET=... \
WEB_ORIGIN=https://your.domain \
  pnpm --filter @amr/tools provision-bucket

# 4) 自述层 + 首个账号
pnpm --filter @amr/tools gen-meta
SEED_EMAIL=... SEED_PASSWORD=... pnpm --filter @amr/tools seed-account

# 5) 起 API
DATABASE_URL=... AUTH_SECRET=... S3_... WEB_ORIGIN=... node apps/api/dist/main.js

# 6) 构建并部署 PWA(纯静态,任何静态托管均可)
VITE_API_BASE=https://api.your.domain pnpm --filter @amr/web build
```

## 5. 部署冒烟

对**真实后端**跑一遍最小链路(与 m0/m1 验收不同:那两个验"实现对不对",这个验"这套部署起不起得来"):

```bash
DATABASE_URL=... S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY=... S3_SECRET_KEY=... \
API_URL=https://api.your.domain SEED_EMAIL=... SEED_PASSWORD=... \
  pnpm --filter @amr/tools deploy-smoke
```

覆盖:鉴权(含错误口令被拒)→ 建档 → presign → **真实预签名直传** → 登记 → 幂等重放 200 → L1 三件套落桶 → 派生物 → 浏览 → AI 作业已同事务投递。

## 6. 启动时会看到的 WORM 姿态

API 启动时探针会打印其中一条:

```
[s3] WORM 姿态:✓ 逐对象保留锁由服务端强制
```

或

```
[s3] WORM 姿态:✗ **服务端不强制 WORM**(后端不支持逐对象保留锁)。
     ADR-048 要求三条补偿全部到位,缺一不可: …
```

**第二种不是警告噪音,是状态声明。** 它出现时,②前缀级保留策略与③异地冷备未落实之前,该桶不得承载生产 L1。

## 7. 已知的部署期限制

| # | 限制 | 出处 |
|---|---|---|
| ~~1~~ | ~~R2 上预签名 PUT 不能带 `x-amz-checksum-sha256`~~ —— **该结论已被推翻**:传 `unhoistableHeaders` 后完全可用且真强制。R2 上的直传链与 MinIO/S3 同构,已实测通过 | ADR-048 更正(2026-08-21) |
| 2 | R2 无版本化 ⇒ journal 的读-改-写追加不可回滚,需 ADR-049 的一事件一对象 | ADR-049(实现暂缓) |
| 3 | 真机必须 HTTPS,局域网 IP 不可用 | m1-99 C 组前置 |
| 4 | PDF 的 S1 路径未实现,记 `unsupported` | m2 实现期 |
