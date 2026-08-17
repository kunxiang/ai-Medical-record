# M0 Spec · 05 认证与授权

## 1. 账号

- M0 **无开放注册**。账号由 `tools/seed-account.ts` 创建(读环境变量 EMAIL/PASSWORD/DISPLAY_NAME),幂等(同 email 再跑 = 更新密码)。
- 密码散列:**argon2id**,参数 memory=64MiB / iterations=3 / parallelism=4。
- `POST /api/v1/auth/login` `{email, password}` → `{access_token}`;失败一律 401 `unauthenticated`(**禁止**区分"用户不存在/密码错")。速率限制:同 IP 10 次/分钟。

## 2. Token

- JWT HS256,密钥 ≥ 32 字节随机(环境变量 `AUTH_SECRET`,缺失即拒绝启动)。
- Claims:`sub`(account_id)、`iat`、`exp`(= iat + 30 天;个人自用,长 TTL 换免刷新,M0 不做 refresh token)。
- 校验失败/过期 → 401 `unauthenticated`。

## 3. `person_access` 中间件(安全边界)

**每个** 以 `/people/:id` 为前缀或携带 `person_id` 参数的路由,**必须**经过同一个中间件:

```
requirePersonAccess(minRole: 'viewer' | 'editor' | 'owner')
```

语义(**逐条必测**):

1. 查 `person_access (account_id = jwt.sub, person_id = 目标)`;无行 → **404 `not_found`**。
   **禁止返回 403** —— 403 泄露"该 person 存在"。资源不存在与无权访问必须不可区分(响应体、状态码、时延量级)。
2. 有行但 `role` 低于 `minRole`(序:viewer < editor < owner)→ 同样 **404**。
3. `person.archived_at IS NOT NULL` → 404(软删除后不可见,M0 无恢复接口)。
4. 角色要求:读 = `viewer`,写(建档、传文档、改档)= `editor`,删档/授权管理 = `owner`(M0 无授权管理接口,仅建档时自动写入一行 `owner`)。
5. **`POST /people` 是唯一不过这张表的写接口**(资源尚不存在);事务内必须原子完成:插 person + 插 `person_access(jwt.sub, person, 'owner')` + 写 `_person.json` + 追加 journal。

## 4. 硬约束

- 中间件是**唯一**做该检查的地方 —— handler 内**禁止**重复或替代实现(单点可审计)。
- 任何绕过(如 `tools/` 脚本直连 DB)只允许在 `tools/` 内,且**禁止**被 apps/api 引用。
- 集成测试必须含:B 账号访问 A 账号的 person → 404;JWT 伪造/过期 → 401;viewer 尝试写 → 404。
