# M1 Spec · 99 验收清单

环境同 M0(compose:PG16 + MinIO)+ **Playwright/Chromium**(环境已预装,`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`)。
入口:`pnpm m1:acceptance`(编排:M0 环境 → 构建 web → 起 API + 静态服务 → Playwright 跑 A 组 → B 组)。

> 为什么必须用真浏览器:M1 的全部风险在 IndexedDB 事务、Service Worker、离线/在线切换、页面重载后的状态恢复 —— 这些在 Node 里 mock 不出来,mock 出来的通过也不构成证据。

## A. 端到端(Playwright 驱动)

| # | 步骤 | 断言 |
|---|---|---|
| A1 | 登录 → 建档(复用 M0 API)→ 打开 PWA | 人员选择器列出该人;刷新后仍默认选中上次所选 |
| A2 | **`context.setOffline(true)`** → 连续"拍" 5 张(注入 5 个不同 fixture 图) | UI 显示「5 张待上传」;IndexedDB `captures` 5 条、`blobs` 5 条;每条 `client_document_id` 唯一且为 uuid v7 |
| A3 | 保持离线 → **刷新页面** | 队列仍是 5 条、状态回退为 `pending`(04 §9)、UI 数字不变 —— **崩溃恢复不丢** |
| A4 | `setOffline(false)` | 60s 内 5 条全部 `done`;服务端 `GET /documents` 返回 5 份;每份 `page_count=1`;5 个 `page-01.*` 的 sha256 与本地计算值逐一相等;manifests 恰增 5 条 add 行;IndexedDB `captures`/`blobs` 清空 |
| A5 | **上传中途刷新**(在第 3 条 `uploading` 时 reload) | 恢复后继续推进至全部 `done`;服务端**仍恰好 5 份**(幂等键生效),`_incoming/` 无残留 current 对象 |
| A6 | 同一份再次入队(相同 `client_document_id`,通过注入构造) | 服务端 200 幂等命中,文档总数不变 |
| A7 | 终止错误路径(注入超 50MiB 的项) | 该项 → `failed_terminal`,UI 显示可读错误;**其余项不受影响**继续上传 |
| A8 | 对 `failed_terminal` 项点"放弃" | `POST /captures/discard` 2xx;journal 出现 `capture_discard` 行(含 client_document_id、reason);本地项清除 |
| A9 | 浏览:打开时间轴 | 按 capture_date 分组倒序;滚动触发下一页(游标);缩略图逐个出现且请求数 ≤ 视口内张数(懒加载生效) |
| A10 | 缩略图惰性生成 | 首次请求 `generated: true`,再次请求 `generated: false`;`derived/{slug}/{doc}/thumb-01.webp` 存在且**无 ObjectLock**(head 无 retention) |
| A11 | **L2 可丢** | 删光 `derived/**` → `tools/regen-derivatives` 重生成 → 页面正常;**`people/**` 的对象版本清单(key+versionId+etag)与删除前逐字节相同** |
| A12 | 软删除 | DELETE → 列表不可见、详情 404、缩略图 404;S3 原件与 manifest add 行仍在;journal 有 `document_archive` |
| A13 | **重建演练(M1 版)** | dropdb → seed → rebuild → 5 份文档恢复且**被软删的那份仍为已归档**(journal 回放);穷尽字段比对通过(沿用 M0 verify-rebuild + archived 列) |
| A14 | PDF 采集 | PDF 入队→上传成功;其缩略图接口返 415;UI 显示占位图,不报错 |
| A15 | 矩阵覆盖扫描 | 桶内对象 ⊆ 权威矩阵(含新增 `derived/**` 派生物 key 形态) |

## B. CI 断言

| # | 断言 |
|---|---|
| B1 | `apps/web` 不依赖 `@amr/api` / `@amr/storage`(仅 contracts) |
| B2 | storage:derived key 往返 + 模糊测试(沿用 M0 性质测试框架) |
| B3 | **派生物确定性**:同一 fixture 生成两次,thumb 与 preview 的 sha256 各自相同 |
| B4 | 派生物**不含 EXIF/GPS**(读回元数据断言为空) |
| B5 | journal 新事件在 `_meta/schemas` 有对应(D10/B8 现有断言自动覆盖) |
| B6 | web 构建通过 + tsc strict;SW 注册代码不拦截 `/api/` 与 S3 域 |
| B7 | 迁移 0001 从零重放通过;新索引存在且为部分索引 |

## C. 人工(一次性,留档 RESULTS.md)

| # | 内容 |
|---|---|
| C1 | 真机 iOS Safari:飞行模式拍 3 张 → 关屏 1 分钟 → 回到应用 → 全部上传成功;确认 UI 文案未承诺后台上传 |
| C2 | 真机 Android Chrome:同上;若安装为 PWA,验证 Background Sync 在应用后台时确实推进 |
| C3 | 医院场景压力(可选):弱网(Playwright 无法模拟真实基站抖动)下拍 5 张的主观体验 |

## 完成定义

A + B 全绿,C1/C2 留档 → M1 关闭,进入 M2 spec。
