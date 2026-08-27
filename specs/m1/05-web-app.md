# M1 Spec · 05 PWA(apps/web,审核 #002 修订版)

## 1. 技术与结构

Vite + React + TypeScript;`vite-plugin-pwa`(Workbox)。目录按 `docs/02` §1:`features/capture`、`features/browse`、`offline/`、`api/`、`ui/`。

**依赖规则**:只依赖 `@amr/contracts`;禁止依赖 `@amr/api`、`@amr/storage`(含 Node crypto 与 S3 语义)。CI 断言。
`api/` 是**手写薄封装**(无 codegen),每个函数以 contracts schema 校验出参。

### Service Worker 配置(必须钉死,否则 A3 概率性通过)

```ts
VitePWA({
  registerType: 'autoUpdate',
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg,woff2}'],
    navigateFallback: 'index.html',
    navigateFallbackDenylist: [/^\/api\//],   // 否则 API 404 会被外壳 HTML 顶掉
    runtimeCaching: [],                        // ★ 不缓存任何 API 与 S3 请求
  },
})
```
SW **只做**外壳预缓存。**无 `sync` 事件处理**(审核 #002 A-8:SW 读不到 token,且触发时无 client 可转发)。

## 2. 认证

登录页 → `POST /auth/login` → token 存 `localStorage`。

> 显式取舍:localStorage 对 XSS 无防护。个人自用、无第三方脚本、功能优先于隐私,接受之。**吊销机制已在 M1 落地**(D12:`token_epoch`,见 [02](./02-api-delta.md) §6)—— 泄露后可通过改密码立即失效全部 token。

401 → 清 token、跳登录页、队列暂停但**不清空**。

## 3. 采集流程

```
① 人员选择器(常驻,默认 kv.last_selected_person_id)—— 离线用 people_cache
② 拍照 / 相册 / PDF → 逐页读入
③ 每页:物化 Blob → 计算 sha256 → 读尺寸与 EXIF → 立即写 blobs + captures(draft)
④ "完成" → 定稿 page_count → pending(或 pending_person)
⑤ UI 显示「已存档 · N 张待上传」  ← 此刻用户可以离开
⑥ 队列引擎前台驱动推进([04](./04-offline-queue.md) §4)
```

### 连拍(iOS 事实修正,审核 #002 A-10)

`<input capture multiple>` 在 iOS 上 `multiple` 被忽略,每次只返回一张。故:

- **连拍** = 重复调起单张 `<input type="file" accept="image/*" capture="environment">`,每张**立即**落盘为 `draft`,累积面板显示已拍页数;`source='camera'`。
- **相册/多选导入** = 不带 `capture` 的 `<input multiple>`;`source='album'`(PDF 则 `pdf`)。
- `capture_order` = 落盘顺序 1..N;`page_no` = `capture_order`(M1 无页脚解析)。
  `[偏差:vs ADR-025「page_no 从页脚解析,拍摄顺序另存 capture_order」—— M1 无 AI,二者暂时相等。key 中的 NN 恒为拍摄序,M2 解析出语义页序后二者可分离 → 新增 ADR-047;ADR-025 加 ⚠️。]`

### ⚠️ 原件字节零改动

`[偏差:vs docs/04 §画质规则「客户端上传前……只做 EXIF 方向校正」与 docs/05 §6 —— 客户端做方向校正必然重编码(有损),与同段「存原图,不压缩」自相矛盾。裁决:原件字节零改动;方向在展示时处理。须回写 04 与 05。]`

- 上传的必须是相机/相册给出的**原始字节**:不解码、不重编码、不旋转、不剥 EXIF。
- **EXIF 只读不写**(审核 #002 A-21):用 `exifr` 之类的纯解析库读 `DateTimeOriginal` 与 `Orientation`。
  - `captured_at`:有 `DateTimeOriginal` → 用之(带原 offset;无 offset 按本机时区补),`captured_at_from_exif=true`;否则用入队时刻并在 UI 标注「无拍摄时间,按导入时间归档」。
    > **为什么重要**:M1 是"抢救存量"里程碑(09 M1 脚注)。相册导入的两年前旧单据若记成今天,会永久落进 `people/{slug}/2026/…` —— key 永不变,这是不可逆的错档,不是 UI 瑕疵。
  - `orientation` 与 `captured_at` 一并进 `PageIn.exif`,服务端原样落 `page-NN.json.exif`。
- 尺寸:`createImageBitmap(blob, { imageOrientation: 'none' })` 读**原始像素**尺寸(与服务端 `page-NN.json` 一致);本地预览用 `<img>`(默认 `image-orientation: from-image` 会自动旋正)。
- PDF 尺寸:`pdf-lib` 读首页 MediaBox 取整 pt(纯解析,不渲染),与 m0-03 §2 的 PDF 语义一致。
- sha256:`crypto.subtle.digest('SHA-256', await blob.arrayBuffer())`。**无分块**(WebCrypto 无增量接口,审核 #002 A-6);单文件 ≤50 MiB 由**入队前**校验保证,超限直接拒绝并提示,不让它走到 presign。
- **HEIC**:不在 mime 白名单。入队前检测,拒绝并提示「iOS 请在 设置→相机→格式 选择『兼容性最佳』,或先转为 JPEG」。

### 归属人

见 [04](./04-offline-queue.md) §5:登录即缓存人员;缓存缺失且离线时允许拍照并置 `pending_person`;`draft/pending_person/pending/failed_terminal` 且未成功 presign 时允许改归属(二次确认)。
上传时一律传 `confirmed_by: 'capture_ui'`([01](./01-contracts-delta.md) §A1)。

人员选择器提供“添加成员”入口，联网调用 M0 既有 `POST /people`。表单至少收集姓名、与账户所有者关系、出生日期和出生时性别；本人档案由注册流程创建，因此关系不再提供 `self`。创建成功后必须同时：

1. 将新成员加入当前选择器并自动选中；
2. 持久化 `kv.last_selected_person_id`；
3. 写入 `people_cache`，且仍只保留 `id / slug / display_name / relation_to_owner` 四项，不得把生日等医疗 PII 带入浏览器人员缓存。

创建需要联网；网络或 API 失败时保留表单内容并给可操作提示，不得伪装成功。

## 4. 队列状态 UI

常驻角标显示待上传数(= `captures` 中非 `draft` 条数)。展开后每项:本地缩略(objectURL)、归属人、页数、状态、下次重试时间、错误详情。

- 文案如实:队列非空时「保持应用打开直到上传完成」;**禁止**"关掉也会传"。
- 未获存储持久化 → 常驻降级提示([04](./04-offline-queue.md) §7)。
- `failed_terminal` 提供**重试**与**放弃**两个动作;放弃需二次确认且明写不可恢复。**永不自动删除**。
- `pending_person` 项置顶红条「N 张待归人」。
- 全部完成 → 「全部已上传」正反馈(内存计数驱动,因 `done` 是瞬态)。

## 5. 浏览

```
/people          我有权访问的人
/people/:id      时间轴:按 capture_date 倒序分组,组内 captured_at 倒序
/documents/:id   详情:逐页 preview,可点开原图(预签名 URL)
```

- 列表走 `GET /documents`(游标分页,滚动到底加载)。
- 缩略图/预览**必须懒加载**:`<img loading="lazy" src="/api/v1/documents/:id/pages/1/thumb">` —— 因接口改为 **302 重定向**,原生懒加载真正生效(审核 #002 A-9);IntersectionObserver 作为不支持环境的兜底。
- 队列中的项在时间轴顶部「待上传」区块展示,**只显示当前所选人的项**;它们没有服务端 `capture_date`,按本地 `captured_at` 折算到浏览器时区分组(与服务端按上传者账号时区折算可能差一天 —— 属显示层,不影响 key)。
- M1 **无软删除按钮**(移交 M2)。

## 6. 离线可用范围(边界声明,非偏差)

| 功能 | 离线 |
|---|---|
| 拍照 / 导入 / 入队 / 改归属 / 放弃(标记) | ✅ |
| 队列状态查看 | ✅ |
| 浏览已上传文档、缩略图、原图 | ❌ M1 不缓存服务端数据(M4 检索时再议) |
