# M1 Spec · 99 验收清单(审核 #002 修订版)

环境:M0 的 compose(PG16 + MinIO)+ **Playwright/Chromium**(预装于 `/opt/pw-browsers`,`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`;`playwright` 进 devDependencies)。
入口:`pnpm m1:acceptance` → `infra/run-m1.sh`(清场 → compose → MinIO 用户/策略 → 迁移 → provision(**含 CORS**)→ _meta → seed → 构建 web → 起 API + 静态服务 → **fixture 生成** → Playwright A 组 → B 组)。

> 为什么必须真浏览器:M1 的风险全在 IndexedDB 事务、SW 外壳缓存、离线/在线切换、重载后的状态恢复。Node 里 mock 出来的通过不构成证据。

## 0. 前置:测试注入面与 fixture(审核 #002 A-12/A-13)

### 0.1 测试注入面

`VITE_M1_TEST_HOOKS=1` 构建时暴露(生产构建中该模块被 tree-shake 掉,CI 断言产物不含 `__amr`):

```ts
window.__amr = {
  enqueueFixture(name: string, opts?: {personId?: string|null, count?: number}): Promise<string[]>,
  queueSnapshot(): Promise<Array<{client_document_id, state, attempt, person_id, page_count}>>,
  pauseAt(stage: 'presign'|'put'|'register', nth: number): void,   // 命中后挂起,不推进
  resume(): void,
  clearAll(): Promise<void>,
};
```
`pauseAt` 是 A5"在第 N 条上传中重载"的**确定性**触发手段 —— 没有它,该用例只能 sleep,必然 flaky 且失败时无法区分产品 bug 与竞态。

### 0.2 fixture 生成(`tools/src/gen-m1-fixtures.ts`,确定性)

M0 的 `fakeJpeg()` 是 libvips **不可解码**的伪 JPEG,沿用它会让所有派生物用例误报。必须生成真实图像:

| 名称 | 内容 | 用途 |
|---|---|---|
| `photo-gps-o6.jpg` | sharp 生成的 JPEG,**写入 EXIF**:`DateTimeOriginal=2023-05-01T09:00:00`、`Orientation=6`、GPS 坐标 | A4b/A4c/B4、EXIF 时间与方向 |
| `photo-plain.png` | 无 EXIF 的 PNG | 基础上传 |
| `doc-1page.pdf` | 单页 PDF(pdf-lib) | A14 |
| `huge.jpg` | > 50 MiB 的合法 JPEG | A7 |
| `page-1/2/3.jpg` | 三张可区分的 JPEG | 连拍多页 |

生成物落 `fixtures/m1/`(**二进制不提交仓库**,由脚本确定性生成;与 `fixtures/README.md` 的"不提交原始影像"一致)。

## A. 端到端(Playwright)

| # | 步骤 | 断言 |
|---|---|---|
| A0 | 环境自检 | `window.isSecureContext === true`;跨源 preflight 探针:对 API 与 S3 各发一次 `OPTIONS` → 200 且 `Access-Control-Allow-*` 含所需头(**置于一切之前**:CORS 错会把后续全部失败误导成队列 bug) |
| A1 | 登录 → 建档 → 打开 PWA | 人员选择器列出该人;`people_cache` 已写入且**不含** `allergies`/`birth_date`;刷新后仍默认选中上次所选 |
| A2 | `setOffline(true)` → 连拍 5 张(`enqueueFixture('photo-plain', {count:5})`) | UI 显示「5 张待上传」;`captures` 5 条、`blobs` 5 条;`client_document_id` 唯一且为 uuid v7;每条 `state='pending'` |
| A3 | 保持离线 → **刷新页面** | 队列仍 5 条;**读回 blob 校验 byte_size 与 sha256 与入队时一致**(证明 Blob 已物化,非 File 引用);UI 数字不变 |
| A4 | `setOffline(false)` | 60s 内 `captures` 清空;服务端 5 份文档;桶内 5 个 `page-01.*` 的 sha256 **与 fixture 文件的已知 sha256 逐一相等**(而非"与本地计算值相等" —— 后者是同义反复,证明不了原件零改动);manifests 恰增 5 条 add 行 |
| A4b | 上传 `photo-gps-o6.jpg` | 桶内原件 EXIF **完整保留**(GPS 与 Orientation 都在);`capture.json.person.confirmed_by === 'capture_ui'`;`page-01.json.exif.orientation === 6`;文档 `capture_date === '2023-05-01'` 且 key 目录段为 `2023/2023-05-01__…`(**EXIF 时间生效,旧单据不落今天**) |
| A4c | 该文档的 thumb/preview | 长宽比按 Orientation=6 旋正后正确(证明"方向在展示时处理"落地);派生物**无 EXIF/GPS**(与 A4b 构成镜像断言) |
| A5 | `pauseAt('put', 3)` → 5 条入队 → 命中后 **reload** | 恢复后继续推进至全部上传;服务端**恰好 5 份**(幂等生效);`_incoming/` 无残留 current 对象 |
| A6 | 同一 `client_document_id` 重新 presign 后重放 | 200 幂等命中,文档总数不变(**这条正是审核 #002 A-1 修复的回归测试**:旧口径下必 409) |
| A7 | `enqueueFixture('huge')` | **入队前即被拒绝**并给可读提示;队列中无该项;其余项不受影响 |
| A7b | 构造 `failed_terminal`(注入 409 冲突)→ 观察 | 该项停在 `failed_terminal`、**blob 仍在**、UI 有"重试"与"放弃"两个动作;**未自动删除** |
| A8 | 对 A7b 的项点"放弃"(经二次确认) | `POST /captures/discard` 2xx;journal 出现 `capture_discard` 行(含 `client_document_id`、`event_id`);本地清除;**重复上报同一 `discard_event_id` 只产生一行** |
| A9 | 连拍 3 页为一份文档 | 服务端 1 份文档 `page_count=3`;桶内 `page-01/02/03.*` 三件套;`capture.json.pages` 长度 3 且 `capture_order` 为 1,2,3 |
| A10 | 离线拍照 + 清空 `people_cache` | 允许拍照,项为 `pending_person`,**不发起 presign**;UI 红条;选人后转 `pending` 并上传成功 |
| A11 | 改归属 | `pending` 项改归属人 → 上传后 key 前缀为新 person;`uploading` 中的项禁止改 |
| A12 | 浏览时间轴(种子 ≥30 份文档,视口 1280×800) | 按 capture_date 分组倒序;滚动触发下一页;**首屏渲染完成后 2s 内 `/thumb` 请求数 ≤ 视口内卡片数 + 2**(懒加载生效) |
| A13 | 惰性生成 | 首次 `X-Amr-Generated: 1`、再次 `0`;两次均 302;`derived/{slug}/{doc}/thumb-01.webp` 存在且 **head 无 ObjectLock retention** |
| A14 | PDF | 上传成功;缩略图 415;UI 占位图,无报错 |
| A15 | 存储配额与持久化 | 未获 `persist()` 时 UI 有降级提示;`estimate()` 剩余不足时入队被拒并提示 |
| A16 | 401 | token 失效后队列**暂停不清空**;重新登录后继续推进至完成 |
| A17 | **L1 零字节变动** | A4 完成时取 `people/**` 的 `(Key,VersionId,ETag)` 全量清单为基线;**A 组结束时**再取一次,逐字节相同(把 A12/A13 的全部 L2 活动都括进来)。⚠️ 两次快照之间禁止任何写 API 调用 —— A8 的 discard 会写 journal,故 A8 必须排在基线之前 |
| A18 | **L2 可丢** | admin 凭证删光 `derived/**` → ①直接浏览(惰性路径)恢复 → ②`tools/regen-derivatives` 再跑一遍 → 两条路径都正常;A17 的 L1 清单仍不变 |
| A19 | 重建演练 | dropdb(含 drizzle schema)→ migrate → seed → rebuild → `verify-rebuild --compare` 通过。`thumb_key` **不在**比对字段表(M1 不写它);`capture_discard` 事件按 `event_id` 忽略且**不进对账报告** |
| A20 | 矩阵覆盖扫描 | 桶内对象 ⊆ 权威矩阵(`parseKey` 全通过,含新增 derived 三类 key) |

## B. CI 断言

| # | 断言 |
|---|---|
| B1 | `apps/web` 只依赖 `@amr/contracts` |
| B2 | storage:derived key 往返 + 模糊测试;`parseKey` 覆盖 thumb/preview/meta |
| B3 | 派生物确定性:同进程内同一 fixture 生成两次,thumb/preview 的 sha256 各自相同 |
| B4 | **源含 GPS ∧ 派生物无 GPS**(强断言,非空断言) |
| B5 | journal 新事件在 `_meta/schemas`、`_meta/registries`、`_meta/README.md` **三处**均已同步(D10 扩展) |
| B6 | web 构建 + tsc strict;SW 配置含 `navigateFallbackDenylist: [/^\/api\//]` 且 `runtimeCaching: []`;生产产物不含 `__amr` 注入面 |
| B7 | 迁移 0001 从零重放;`schema.ts` 与迁移无漂移(drizzle-kit generate 无新增) |
| B8 | **UI 文案不含"后台自动上传/关掉也会传"类承诺**(grep 断言,防实现期漂回) |
| B9 | **D12**:改密码后旧 token 立即 401 |
| B10 | **D11**:建档后 `_index/audit/{YYYY-MM}.jsonl` 出现 `access_grant` 行 |
| B11 | 幂等指纹函数单测:改 `batch_id`/`upload_id`/`exif` 不影响指纹;改 `sha256`/`page_no`/`capture_order` 必改变指纹 |
| B12 | spec 中出现的每个 `D\d+` 在 `docs/design-debt.md` 有对应行(防悬空引用复发) |

## C. 人工(真机,留档 RESULTS.md)

**前置(审核 #002 A-7)**:真机走局域网 IP = **非安全上下文**,`crypto.subtle`/SW/Web Locks/StorageManager 全部不可用 —— C 组必须用 HTTPS(mkcert 本地 CA + 证书装入设备信任链)。**第 0 步断言 `window.isSecureContext === true`,否则整组无效。**

| # | 内容 |
|---|---|
| C1 | iOS Safari(**添加到主屏幕**):飞行模式拍 3 张 → 关屏 1 分钟 → 回到应用 → 全部上传成功;确认文案未承诺后台上传;确认存储持久化提示行为正确 |
| C2 | Android Chrome:同上;Background Sync 不作为断言(M1 无 SW sync 路径) |
| C3 | 真实医院单据拍摄:连拍 3 页 → 检查页序、EXIF 时间、归属人正确 |

## 完成定义

A + B 全绿,C1/C2 留档,**D11/D12 已勾销(B9/B10 绿即为凭证)** → M1 关闭。
