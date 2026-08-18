# M1 验收结果

执行:2026-08-18,开发/CI 环境(docker compose:PG16 + MinIO;Playwright/Chromium 1194)。
执行方式:`pnpm m1:acceptance`(infra/run-m1.sh:清场 → compose → MinIO 用户/策略 → 迁移 → provision(含 CORS)→ _meta → seed → fixtures → 构建 web(含注入面)→ 起 API + 静态服务 → A 组 → B 组)。

## A 组(端到端 Playwright):88/88 全绿

A0 安全上下文与跨源预检 ✓ · A1 登录/选择器/`people_cache` 无医疗 PII ✓ · A2 离线连拍 5 张 ✓ · A3 离线刷新后 blob 已物化且 sha256 == fixture 已知值 ✓ · A4 恢复网络 60s 内清空、原件字节零改动、manifests 恰 +5 ✓ · A4b EXIF 时间生效(旧单据不落今天)、`confirmed_by=capture_ui`、`capture_order`、`exif.orientation=6` 均已落 L1 ✓ · A4c 派生物按 Orientation 旋正、未上锁、无 EXIF/GPS ✓ · A5 上传中途重载后续跑、幂等、`_incoming` 无残留 ✓ · **A6 重放 200 幂等命中且异 payload 仍 409** ✓ · A7 >50MiB 入队前被拒 ✓ · **A7b 终止态保留本地原件、给出重试与放弃两个动作** ✓ · **A8 放弃经二次确认上报、journal 恰一行、重放仍一行** ✓ · A9 连拍三页成一份 ✓ · A10 先拍后选 ✓ · **A11 改归属落新前缀、uploading 中被拒且按钮消失、挂起项由崩溃恢复续跑** ✓ · A12 时间轴与懒加载 ✓ · A13 惰性生成标记 ✓ · A14 PDF 上传成功/缩略图 415 ✓ · **A15 未获持久化有降级提示、配额不足入队被拒** ✓ · **A16 401 后队列暂停不清空、重新登录续跑至完成** ✓ · A17 L1 全程零字节变动 ✓ · A18 L2 可丢(惰性路径 + regen 工具双通道)✓ · **A19 删库重建等价性通过、capture_discard 不进对账报告** ✓ · A20 桶内对象 ⊆ 权威矩阵 ✓

## B 组(CI 断言):全过

B1 apps/web 只依赖 contracts ✓ · B2 storage derived key 往返 + 模糊(9 例)✓ · B3 派生物确定性(清空重建后字节相同)✓ · B4 **源含 GPS ∧ 派生物无 GPS**(双向强断言)✓ · B5 journal 事件三处同步 ✓ · B6 SW 配置 + 生产产物不含 `__amr`/`installTestHooks` ✓ · B7 迁移从零重放 + schema 无漂移 ✓ · B8 UI 文案不承诺后台上传 ✓ · B9(D12)改密码后旧 token 立即 401 ✓ · B10(D11)审计有 `access_grant` 行 ✓ · B11 幂等指纹单测(13 例)✓ · B12 无悬空设计债引用 ✓

## C 组(人工,真机)

| # | 结果 |
|---|---|
| C1 | ⏳ 待项目所有者:iOS Safari 加主屏 → 飞行模式拍 3 张 → 关屏 1 分钟 → 回应用全部上传成功(**须 HTTPS**,局域网 IP 非安全上下文则整组无效) |
| C2 | ⏳ 待项目所有者:Android Chrome 同上 |
| C3 | ⏳ 待项目所有者:真实医院单据连拍 3 页,核对页序、EXIF 时间、归属人 |

## 验收期实证修复

### 一、验收清单本身的缺口(最重要的一条)

自动化脚本一度只覆盖 spec A 表的一个子集(缺 A6/A7b/A8/A11/A15/A16/A19,B 表缺 B3–B8/B11),而它跑出的是"51/51 全绿"。按 `specs/README` 硬约定这是 A 档 blocker,已补齐至 88 项。
**教训:全绿只说明"跑过的都过了",不说明"该跑的都跑了"。逐条比对 spec 与脚本必须是收口动作,不能省。**

### 二、补齐后立刻暴露的产品缺陷(全是"契约写了、实现没跟上")

| # | 缺陷 | 由哪条抓到 |
|---|---|---|
| 1 | `POST /documents` 仍拿**整包 canonical payload** 做幂等键,而非 `idempotencyFingerprint` —— 重试必然重新 presign、`batch_id` 必变 ⇒ **每次重试都 409 终止**。正是审核 #002 A-1 要消除的失败,函数写进了 contracts 却没接线 | A6 |
| 2 | `appendJournal` 用新生成的 uuid **覆盖**调用方传入的 `event_id` —— 客户端持久化的 `discard_event_id` 被丢弃,重放幂等失效 | A8 |
| 3 | 401 后 `pauseQueue()` 永久置停,重新登录只调 `tick()` 被 `paused` 拦掉 ⇒ **队列再也不会恢复** | A16 |
| 4 | 放弃上报无服务端幂等 → 新增 `capture_discard_event` 台账(迁移 0002) | A8 |
| 5 | 进入 `uploading` 后不发 `onChange`,UI 仍显示"改归属"按钮;点了会抛未捕获异常且用户无反馈 | A11 |

### 三、测试设施自身的缺陷(会伪造出"通过")

| # | 现象 | 处置 |
|---|---|---|
| 6 | `pauseAt` 实现为"抛错"而非 spec §0.1 写明的"挂起,不推进" —— 队列自己把状态清理干净了,崩溃恢复路径从未被测到 | 改为真挂起;A5 因此真正走 `recoverAfterRestart` |
| 7 | `addInitScript(fn)` 经 esbuild `keepNames` 处理后含 `__name()` 调用,浏览器无该符号 ⇒ **init script 静默 ReferenceError,StorageManager stub 从未生效**,而 A15 的两条断言在真实大配额下"看起来通过" | 改 `content` 字符串注入;并加一条**自证断言**先读回 `estimate()` 再断言 —— 这条自证正是发现问题的手段 |
| 8 | 注入面的 fixture 缓存挂在闭包里,而安装点 `useEffect` 依赖 `selected`,换归属人会重装并清空缓存 | 缓存提到模块级 |
| 9 | `exifr.parse({pick})` 取不到 IFD0 的 Orientation | 改走 `exifr.orientation()` 专用入口 |
| 10 | A12 计数把 302 目标(`derived/…/thumb-01.webp`)也算进"缩略图请求" | 正则收紧到 API 路径 |
| 11 | `pnpm run x -- --flag` 不透传 argv(与 M0 的 verify-rebuild 同一个坑) | 改 `npx tsx` |
| 12 | MinIO 不实现 `PutBucketCors`(501);自检从"读回配置比对"改为"发真实 preflight" | m1/CHANGES #2 |
| 13 | AWS SDK 强制 CRC32 校验和被 MinIO 拒;Content-MD5 中间件必须挂在 `build` 步(挂 `finalizeRequest` 则头不进签名 → AccessDenied) | m1/CHANGES #3 |
| 14 | `import.meta.env['X']` 方括号取值不被 Vite 编译期替换 ⇒ 测试注入面漏进生产产物 | 改点号取值 + `vite-env.d.ts`;B6 现在双向断言 |

新断言均做过故障注入验证(B7 改 schema、B8 改文案 → 均如期变红),非同义反复。

## 结论

A(88/88)+ B(12 项)全绿,D11/D12 已勾销。C1–C3 待项目所有者在真机执行后 M1 关闭。
