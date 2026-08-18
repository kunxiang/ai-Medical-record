# M1 Spec · 05 PWA(apps/web)

## 1. 技术与结构

Vite + React + TypeScript;PWA 由 `vite-plugin-pwa`(Workbox)提供 manifest 与 Service Worker。目录按 02 §1:

```
apps/web/src/
├── features/capture/     拍照/导入、人员选择器、队列状态
├── features/browse/      人 → 时间轴 → 文档详情
├── offline/              IndexedDB 封装、队列引擎、SW 注册(★ 平台特有,不可移植)
├── api/                  由 contracts 生成的 fetch 客户端(零业务逻辑)
└── ui/                   通用组件
```

**依赖规则**:`apps/web` 只依赖 `@amr/contracts`;**禁止**依赖 `@amr/api`、`@amr/storage`(storage 含 Node crypto 与 S3 语义,属服务端)。CI 断言(B 组)。

Service Worker 只做两件事:应用外壳预缓存、Chromium 上的 `sync` 事件转发给队列引擎。**禁止**用 SW 拦截 API 或 S3 请求(会干扰预签名与幂等语义)。

## 2. 认证

登录页 → `POST /auth/login` → token 存 `localStorage`。

> 显式取舍:localStorage 对 XSS 无防护。本项目为个人自用、无第三方脚本、功能优先于隐私(项目所有者立场),接受之;M2 引入吊销机制(D12)时一并复审。

401 → 清 token、跳登录页、**队列暂停但不清空**(04 §3)。

## 3. 采集流程(05 §1 的实现)

```
① 人员选择器(界面常驻,默认上次所选)—— 离线可用,无网络调用
② 拍照 / 相册 / PDF / 截图 → 逐页读入
③ 计算 sha256(WebCrypto)、读取尺寸 → 写 IndexedDB(blobs + captures)
④ UI 立即显示「已存档 · N 张待上传」  ← 此刻用户可以离开
⑤ 队列引擎在后台推进(04 §5)
```

- **连拍模式**:`<input type="file" accept="image/*" capture multiple>` + 累积面板,拍完统一入队为一份多页文档。`page_no` 按拍摄顺序 1..N。
- **人员选择器**:从 `GET /people` 拉取并缓存到 IndexedDB(离线时用缓存渲染);**首次使用必须在线**完成一次拉取。缓存缺失且离线 → 禁止拍照并提示,**禁止**让用户在不知道归属人的情况下拍摄入队。
- 每份文档的归属人**只在入队时确定一次**;队列中的项不提供改归属(ADR-041:归人是拍摄现场的断言;错了走 M2 的纠正流程)。

### ⚠️ 原件字节不得改动

04 §画质规则要求"存原图,不压缩"。因此客户端**必须原样上传相机/相册给出的字节**,不解码、不重编码、不旋转、不剥 EXIF。

`[偏差:vs 04 §画质规则 "客户端上传前……只做 EXIF 方向校正" —— 客户端做方向校正必然重编码(有损),与同段"存原图,不压缩"自相矛盾。裁决:原件字节零改动;方向在**展示时**处理(派生物生成用 sharp.rotate,前端用 CSS)。须回写 04。]`

- `width`/`height`:图片用 `createImageBitmap` 读取(不改动源);**PDF 用 `pdf-lib` 读首页 MediaBox 取整 pt**(纯解析,不渲染),与 m0-03 §2 的 PDF 语义一致。
- sha256 用 `crypto.subtle.digest('SHA-256', arrayBuffer)`;大文件分块读入避免一次性驻留内存。

## 4. 队列状态 UI(01 §离线优先的硬要求)

常驻角标显示待上传数;展开后每项显示:缩略(本地 blob objectURL)、归属人、页数、状态、下次重试时间、错误详情。

- 文案**必须**如实:iOS 上显示「保持应用打开直到上传完成」(04 §5),不得暗示后台自动完成。
- `failed_terminal` 项提供两个动作:**重试**(清错误回 `pending`)与**放弃**(走 04 §6 的 `capture_discard`)。
- 全部完成 → 明确的「全部已上传」正反馈。

## 5. 浏览(09 M1:按人 → 时间轴 → 文档)

```
/people                 我有权访问的人(未归档)
/people/:id             时间轴:按 capture_date 倒序分组,组内按 captured_at 倒序
/documents/:id          详情:逐页 preview,可点开原图(预签名 URL)
```

- 列表走 `GET /documents`(游标分页,滚动到底加载下一页)。
- 缩略图/预览图**必须懒加载**(IntersectionObserver;`<img loading="lazy">` 作兜底)—— 惰性生成的前提(03 §3)。
- 未上传完成的队列项在时间轴顶部以「待上传」区块展示,与服务端文档视觉区分。
- 文档详情提供软删除(二次确认;文案说明"原件仍保留在存储中,仅从列表隐藏")。

## 6. 离线可用范围

| 功能 | 离线 |
|---|---|
| 拍照 / 导入 / 入队 | ✅(人员缓存存在时) |
| 队列状态查看 | ✅ |
| 浏览已上传文档列表 | ❌ M1 不缓存服务端列表(M4 检索时再议) |
| 缩略图/原图 | ❌ |

`[偏差:vs 无 —— 09 未要求离线浏览;此处显式声明边界,避免实现者自行发挥。]`
