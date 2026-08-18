# M1 Spec · 04 离线队列(审核 #002 修订版)

> 01 §离线优先:**写入本地成功即视为"已存档",UI 立刻给正反馈。**
> M1 全部技术复杂度所在,"一张不丢"的唯一承载者。

## 1. IndexedDB 结构

```
DB 名:amr-capture     版本:1     封装库:idb
store `captures`(keyPath 'client_document_id')  索引 idx_state(state)、idx_created(created_at)
store `blobs`(keyPath ['client_document_id','page_no'])
store `people_cache`(keyPath 'id')              人员选择器的离线数据源
store `kv`(keyPath 'k')                         last_selected_person_id、people_fetched_at、persist_granted
```

`captures` 记录:

```ts
{
  client_document_id: string,   // ★ 拍摄瞬间生成的 uuid v7,幂等锚点,终生不变
  person_id: string | null,     // null ⇒ state='pending_person'(见 §5)
  person_slug: string | null, person_display_name: string | null,
  source: 'camera'|'album'|'pdf',           // M1 可达三值(§10)
  captured_at: string,          // EXIF DateTimeOriginal 优先,否则入队时刻(05 §3)
  captured_at_from_exif: boolean,
  page_count: number,
  state: 'draft'|'pending_person'|'pending'|'uploading'|'registering'|'pending_discard'|'failed_terminal',
  attempt: number, next_attempt_at: number,
  last_error: { stage: 'presign'|'put'|'register', code: string, message: string, at: string } | null,
  batch: { batch_id: string, uploads: Array<{page_no, upload_id, url, headers, expires_at}> } | null,
  discard_event_id: string | null,          // 放弃时生成并持久化,保证重放幂等
  created_at: string,
  context: null,                            // M3 预留,恒 null
}
```

`blobs` 值:`{ blob: Blob, byte_size, sha256, mime_type, width, height, capture_order, filename, exif }`。

**★ 必须物化为 Blob**(审核 #002 A-9):入队时 `new Blob([await file.arrayBuffer()], { type })`,**禁止**直接持久化 `File` 实例 —— `File` 携带宿主文件引用,相机/相册的临时文件被系统回收后跨会话读取会抛 `NotFoundError`,而此时 UI 早已告诉用户"已存档"。

## 2. 状态机

```
[每拍一页/选一文件] ──立即落盘──> draft ──("完成"定稿 page_count)──> pending_person? ──选人──> pending
                                    │                                                    │
                              (可随时改归属人 / 删草稿)                    ┌──────────────┘
                                                                          ▼
   pending ──presign+逐页PUT──> uploading ──POST /documents 2xx──> [删两 store,瞬态 done]
      ↑                             │                  │
      │                             │            (可重试)│
      └──── 退避 / online / 前台化 ──┴──────────────────┘
      │
      └── 终止错误 ──> failed_terminal ──(用户点"放弃")──> pending_discard ──上报成功──> [删除]
```

**硬规定:**

1. **每页读入后立即写盘**(审核 #002 A-16):累积面板期间的照片若只在内存,iOS 相机返回时标签页被回收即全丢,而 UI 从未承诺过它们"已存档"。`draft` 记录在重启后必须能还原到累积面板。
2. **presign 在上传时取,不在拍照时取**:预签名 15 分钟、批次 24 小时过期,离线排队可能数小时。
3. **`client_document_id` 拍摄瞬间生成并落盘**,重试/重启/重新 presign 一律复用。
4. **每次重试重新 presign**(新 batch_id);服务端幂等口径已排除 `batch_id`([01](./01-contracts-delta.md) §A3),故重试安全。
5. **`done` 是纯瞬态**(审核 #002 A-13):收到 2xx 后在**同一个跨两 store 的 IDB 事务**里删除元数据与 blob;`state` 枚举中不含 `done`。UI 的"已完成 N 份"由内存计数器驱动。
   > ⚠️ IDB 事务在让出事件循环时自动提交 —— 网络调用必须在事务**之外**完成,收到 2xx 后**新开**事务(审核 #002 B-1)。
6. **崩溃恢复**:启动时把 `uploading`/`registering` 一律回退为 `pending`(重跑由服务端幂等兜底);`draft`/`pending_person`/`failed_terminal`/`pending_discard` 保持不动。
7. **多页部分失败**:整批回 `pending` 全部重传(与规定 4 一致);UI 必须显示"已传字节将被丢弃"。断点续传见 **D14**。
   `[偏差:vs 01 §离线优先「分片 + 断点续传」—— M1 用整文件单 PUT + 整份重传;理由:预签名 multipart 需三段式与服务端状态,属 M2 任务队列范畴。代价:≤50 MiB 单份在弱网下可能长期不收敛。已登记 D14。]`

## 3. 错误分类(按三段,覆盖 `ERROR_CODES` 全集)

| 阶段 | 响应 | 分类 | 处理 |
|---|---|---|---|
| **presign** | 网络失败 / 5xx / 429 | 可重试 | 退避 |
| | 400 `validation_failed`(超 50 MiB、mime 非白名单) | 终止 | → `failed_terminal`。**应在入队前拦截,不该走到这里** |
| | 404 `not_found`(person 被归档或权限撤销) | **person 不可用** | 该人的全部队列项暂停,UI 提示;不增 attempt |
| | 401 | 鉴权失效 | 全队列暂停,提示重新登录;不增 attempt |
| **S3 PUT** | 网络失败 / 5xx | 可重试 | 退避 |
| | 403(预签名过期) | 需重新 presign | 清 `batch` 回 `pending`,不增 attempt |
| | 400(校验和不符) | 终止 | → `failed_terminal`(本地文件已损坏) |
| **register** | 200 / 201 | 成功 | → 删除(§2.5) |
| | 409 `duplicate_client_document_id` | 终止 | 同一幂等键曾以不同内容提交,客户端不可自愈,必须让人看见 |
| | 409 `sha256_mismatch` | 终止 | 本地内容与登记不符 |
| | 409 `upload_consumed` | 需重新 presign | 该批次已被消费(多标签竞态),重新走一遍;服务端幂等会命中 |
| | 422 `upload_incomplete` | 需重新 presign | |
| | 413 / 422 `unsupported_media_type` | 终止 | |
| | 400 `validation_failed` | 终止 | 若 `details` 指向 `captured_at` → 提示"设备时间可能不准,请校时"(服务端要求 ≤ now+24h) |
| | 500 `internal_error` | **终止** | 服务端已判定存储不一致,重试不会自愈(不同于普通 5xx) |
| | 404 | person 不可用 | 同上 |
| **兜底** | 未列举的 4xx | 终止 | 未列举的 5xx | 可重试 |

## 4. 退避与触发

```
delay(attempt) = min(2^attempt × 1000ms, 5min) × (0.5 + random()/2)     // 全抖动
```

**两条硬规定**(审核 #002 A-17,否则 A4 的 60s 窗口随机失败):

1. `navigator.onLine === false` 时**不发起尝试、不增 attempt**。
2. `online` 事件与前台化**必须**把所有 `pending` 项的 `next_attempt_at` 置 0 —— 网络类退避不跨越网络状态变化。

**永不自动放弃**:可重试错误无论多少次都停在 `pending`(01 §离线优先)。attempt ≥ 12 后降为"仅前台可见时重试"。

| 触发 | 平台 |
|---|---|
| 前台化 / `visibilitychange` 可见 | 全部 —— **主力** |
| `online` 事件 | 全部 |
| 可见时每 30s 扫到期项 | 全部 |

**★ 无 Service Worker `sync` 路径**(审核 #002 A-8/A-3):SW 读不到 `localStorage` 里的 token;且 Background Sync 真正触发时页面已关闭、无 client 可转发 —— 这条路径在设计上不成立。Background Sync 仅 Chromium 系支持(Firefox 与 iOS Safari 均无),不作为任何依赖。
`[偏差:推翻 ADR-013 决策句"Service Worker 后台重试" → 新增 ADR-046;回写 ADR-013 ⚠️、docs/01 §离线优先流程图、docs/05、09。]`

> UI 必须如实:队列非空时提示「保持应用打开直到上传完成」,**禁止**任何"关掉也会传"的暗示。CI 断言文案不含此类承诺。

## 5. 归人:允许"先拍后选"(审核 #002 A-24 改判)

- 登录成功即强制拉取 `GET /people` 写入 `people_cache`(登录必然在线),把"缓存缺失"压到近乎不可达;启动时若在线则静默刷新。
- 缓存缺失且离线时**允许拍照**:`person_id = null`,状态 `pending_person`,**禁止 presign/上传**,UI 顶部红条「N 张待归人,选人后才会上传」。
  → ADR-002"不允许无归属文档静默入库"完好(未归属者根本不会被上传);01 §离线优先"拍下的字节不丢"也保住。
- **允许改归属**(审核 #002 A-25):`draft`/`pending_person`/`pending`/`failed_terminal` 且尚未成功 presign 时可改(二次确认);进入 `uploading` 后禁止(key 已由 person 决定)。
  > 原 spec"队列内不提供改归属"是以 ADR-041 之名加的私货 —— 该 ADR 只规定"归人在拍摄现场本地完成",未禁止修改。叠加 M1 无纠正路径会让错档不可逆,命中 00 §6 失败标准。已上传文档的纠正登记为 **D15**。
- `people_cache` **只缓存** `id / slug / display_name / relation_to_owner`;**禁止**缓存 `birth_date`/`allergies`/`chronic_conditions` —— 选择器不需要,而它们是医疗 PII(显式取舍,与 05 §2 的 token 取舍同格式)。

## 6. 放弃(唯一的删除触发点)

**`failed_terminal` 禁止任何自动删除**(审核 #002 A-15):iOS 上 `capture` 拍的照片通常不落相册,本地 blob 就是唯一副本;一次误判的终止错误若自动删除,就是"一张不丢"的反例。

用户点"放弃" → 二次确认(文案明写"本地这份照片将被删除且无法恢复")→ 生成并持久化 `discard_event_id` → `pending_discard`:

- 在线:`POST /captures/discard` 2xx → 删两 store。
- 离线:保留 blob 与元数据,联网后补报;**在补报成功前不删 blob**。

## 7. 存储持久性与配额(审核 #002 A-11)

1. 启动时若 `navigator.storage?.persist` 存在则请求持久化,结果存 `kv.persist_granted`。
2. **未获持久化**(含 Safari 不实现 `persist()` 的情形)→ UI 常驻降级提示:「浏览器可能在长期不使用后清理本地数据;iOS 请把本站『添加到主屏幕』以获得持久存储,并尽快联网上传」。
   > WebKit 对 script-writable 存储有"7 天无交互即清除"策略,**已加入主屏幕的 Web App 豁免**。这是"一张不丢"最现实的失效路径。
3. 入队前 `navigator.storage?.estimate()`:剩余 < 3× 待写字节 → 拒绝并提示先联网上传。`estimate()` 不可用(旧 iOS)→ **fail-open** 并记警告,不阻断拍照。
4. 写入抛 `QuotaExceededError` → 红色告警,保留已成功入队项,**禁止静默丢弃**。

## 8. 多标签页

`navigator.locks.request('amr-upload-queue', ...)` 保证同时只有一个标签页推进;`navigator.locks` 不可用(含非安全上下文)时退化为各自推进 —— 服务端幂等键兜底(口径已修正,重试不再 409)。

## 9. 不变式

| 不变式 | 说明 |
|---|---|
| `client_document_id` 生成后永不变 | 幂等锚点 |
| `state ∈ 枚举`(七值) | 崩溃恢复只回退 `uploading`/`registering` |
| `draft`/`pending_person`/`pending`/`uploading`/`registering`/`failed_terminal`/`pending_discard` ⇒ blob 完整存在 | 唯一的删除时机是 2xx 或 discard 上报成功 |
| 成功 2xx ⇒ 同事务删两 store | 无中间态残留 |
| UI 待上传数 == `captures` 中非 `draft` 的条数 | 用户信任的直接来源 |
| 未获持久化 ⇒ UI 必有降级提示 | 不许假装安全 |

## 10. `source` 取值(WORM 字段,必须写死)

`capture="environment"` 的 input 触发 → `camera`;mime 为 `application/pdf` → `pdf`;其余 → `album`。
`screenshot`/`scan`/`import` 在 M1 **不可达**(实现者不得为其发明触发条件 —— 与 m0-02 §2.6 对 `status` 的处理同体例)。
