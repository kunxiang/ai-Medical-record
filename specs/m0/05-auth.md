# M0 Spec · 05 认证与授权

审核 #001 修订。

## 1. 账号

- M0 **无开放注册**。账号由 `tools/seed-account.ts` 创建(env:EMAIL/PASSWORD/DISPLAY_NAME),幂等(同 email 再跑 = 更新密码)。
- 密码散列:**argon2id**,memory=64MiB / iterations=3 / parallelism=4(库默认盐长/输出长)。参数无版本标记的迁移问题 → 设计债 D12。
- `POST /api/v1/auth/login` `{email, password}` → `{access_token}`;失败一律 401 `unauthenticated`(禁止区分"用户不存在/密码错")。
- 限流(审核 #001 B10):固定窗口,单实例内存计数,键 = 直连对端 IP(M0 无反代,**不信任** `X-Forwarded-For`),10 次/分钟;超限 **429 `rate_limited`**。

## 2. Token

- JWT **HS256**;验证端算法白名单锁死 `['HS256']`(alg-confusion 防御);时钟偏移 leeway 60s。
- 密钥 ≥ 32 字节随机(env `AUTH_SECRET`,缺失/过短即拒绝启动)。
- Claims:`sub`(account_id)、`iat`、`exp`(= iat + 30 天)。仅校验这三项。
- **显式接受(审核 #001 C1)**:M0 无吊销 —— 改密码不失效已签 token,单密钥泄露 = 全权限 30 天。个人自用 + 无公网暴露前提下接受;吊销方案绑 D12(M1 前)。
- 校验失败/过期 → 401 `unauthenticated`。

## 3. 授权中间件(安全边界,**唯二**检查点)

```
requirePersonAccess(minRole)      // 路由含 person_id(路径或 body)
requireDocumentAccess(minRole)    // 路由以 document_id 定位(审核 #001 #11)
```

`requirePersonAccess` 语义(逐条必测):

1. 查 `person_access (account_id = jwt.sub, person_id = 目标)`;无行 → **404 `not_found`**。
   **禁止 403** —— 不泄露档案存在性;资源不存在与无权访问必须不可区分(状态码与响应体完全一致;时延不做显式区分,不设为验收项 —— 审核 #001 B11)。`[偏差:vs 07 §8 的 403 person_access_denied —— 已回写 07 移除]`
2. 有行但 role 低于 `minRole`(viewer < editor < owner)→ 同样 404。
3. `person.archived_at IS NOT NULL` → 404(M0 无恢复接口)。

`requireDocumentAccess` 语义:查 `document` 不存在 → 404;存在 → 取其 `person_id` 走上述 1–3。两个中间件**共享同一实现核心**,是仅有的两个检查点 —— handler 内禁止重复或替代实现。

角色要求:读 = viewer;写(建档、改档、identifiers、presign、建 document)= editor;归档 person = owner。`POST /people` 是唯一不过检查的写接口(资源尚不存在),其原子步骤见 06 §1。

## 4. 硬约束

- 任何绕过(直连 DB 的脚本)只允许在 `tools/` 内,禁止被 apps/api 引用。
- 集成测试必须含:B 账号访问 A 的 person / document / 页 URL → 全部 404;伪造/过期 JWT → 401;`alg:none` 与 RS256 混淆攻击 → 401;viewer 尝试写 → 404;登录超限 → 429。
