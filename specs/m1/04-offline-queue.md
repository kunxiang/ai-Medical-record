# M1 Spec · 04 离线队列

> 01 §离线优先:**写入本地成功即视为"已存档",UI 立刻给正反馈。**
> 这是 M1 全部技术复杂度的所在,也是"一张不丢"的唯一承载者。

## 1. IndexedDB 结构

```
DB 名:amr-capture     版本:1
store `captures`(keyPath: 'client_document_id')
  索引 idx_state       → state
  索引 idx_created     → created_at
store `blobs`(keyPath: ['client_document_id', 'page_no'])
  值:{ blob: Blob, byte_size, sha256, mime_type, width, height, filename }
```

**原件 blob 与元数据分表**:元数据频繁读写(状态机、重试计数),blob 只在上传时读一次;分开可避免每次状态更新都搬运几 MB。

`captures` 记录:

```ts
{
  client_document_id: string,   // ★ 拍摄瞬间生成的 uuid v7,幂等键,终生不变
  person_id: string,            // ★ 拍摄时本地手选(ADR-041)
  person_slug: string,          // 冗余,供 capture_discard 事件用
  person_display_name: string,  // 冗余,离线时 UI 显示
  source: DocumentSource,
  captured_at: string,          // 客户端原文,带本机 offset
  page_count: number,
  state: 'pending'|'uploading'|'registering'|'done'|'failed_terminal',
  attempt: number,
  next_attempt_at: number,      // epoch ms
  last_error: { code: string, message: string, at: string } | null,
  batch: { batch_id: string, uploads: Array<{page_no, upload_id, url, headers, expires_at}> } | null,
  created_at: string,
  context: null,                // M3 预留位,M1 恒 null
}
```

## 2. 状态机

```
[拍照/导入] → pending ──(取 presign + 直传全部页)──> uploading
                 ↑                                        │
                 └──(可重试错误:退避后回落)──────────────┘
                                                          ↓
                                        registering ──(POST /documents 2xx)──> done
                                             │                                   │
                                    (可重试错误 → pending)              (删本地 blob + 元数据)
                                             │
                                    (终止错误)→ failed_terminal
```

**硬规定:**

1. **presign 在上传时取,不在拍照时取。** 预签名 URL 15 分钟过期、批次 24 小时过期;离线排队可能持续数小时。拍照时取 = 队列里躺着一堆废凭证。
2. **`client_document_id` 在拍照瞬间生成并落盘**,此后任何重试、重启、重新 presign 都复用它 —— 它是服务端幂等的唯一锚点(m0-06 §3)。
3. **每次重试重新 presign**(新 batch_id),旧批次由服务端 24h 过期 + `_incoming` lifecycle 回收。允许浪费,不允许错乱。
4. **`state` 变更必须与 blob 删除在同一个 IndexedDB 事务**里完成,否则崩溃会留下"已 done 但 blob 还在"或反之。
5. 上传成功但 `POST /documents` 未确认时**禁止**删 blob。删除的唯一触发点是收到 2xx。

## 3. 错误分类(决定重试还是放弃)

| 类别 | 判据 | 处理 |
|---|---|---|
| **可重试** | 网络失败/超时;HTTP 408、429、5xx;S3 PUT 非 2xx 且非 4xx | 退避重试,`attempt++` |
| **需重新 presign** | 422 `upload_incomplete`、预签名 403/过期 | 清 `batch`,回 `pending`,不计入终止 |
| **终止** | 400 `validation_failed`、409 `duplicate_client_document_id`(payload 不同)、413、422 `unsupported_media_type` | → `failed_terminal`,UI 显式报错 |
| **视为成功** | 200(幂等命中)、201 | → `done` |
| **鉴权失效** | 401 | 暂停队列,提示重新登录;**不**计入 attempt(避免耗尽重试预算) |

> 409 `duplicate_client_document_id` 意味着同一幂等键曾以不同 payload 提交过 —— 客户端不可能自愈,必须让人看见。

## 4. 退避策略

```
delay(attempt) = min(2^attempt × 1000ms, 5min) × (0.5 + random()/2)   // 全抖动
attempt ≥ 12(约 45 分钟累计)且仍为可重试错误 → 保持 pending,但降为"仅前台重试"
```

**永不自动放弃**:可重试错误无论重试多少次都停留在 `pending`(01 §离线优先:失败即丢会摧毁信任)。只有终止错误进 `failed_terminal`。

## 5. 触发时机(iOS 现实约束)

| 触发 | 平台 |
|---|---|
| 应用前台化 / `visibilitychange` 可见 | 全部 —— **主力触发** |
| `online` 事件 | 全部 |
| 定时器(应用可见时每 30s 扫一次到期项) | 全部 |
| Service Worker `sync` 事件(Background Sync) | 仅 Chromium;**iOS Safari 不支持** |
| Periodic Background Sync | 仅已安装 PWA 的 Chromium;**不作为依赖** |

> ⚠️ **iOS Safari 无 Background Sync**(05 已指出 iOS 的诸多限制)。因此 09 的"Service Worker 后台重试"在 iOS 上**不可能**成立,队列推进必须由前台驱动。
> UI 必须据此表达:队列非空时提示「保持应用打开直到上传完成」,**禁止**承诺"关掉也会传"。
> `[偏差:vs 09 M1 "Service Worker 后台重试" —— iOS 平台不可实现,降级为前台驱动 + Chromium 上的 Background Sync 加成。须回写 09 与 05。]`

## 6. 用户放弃与终止失败 → journal

`failed_terminal` 或用户主动删除队列项时:

1. 若在线:`POST /api/v1/captures/discard`(见下)→ 服务端写 journal `capture_discard`(01 §4)→ 本地删除。
2. 若离线:标记 `pending_discard`,**保留元数据**(blob 可先删以释放空间),联网后补报。

```
POST /api/v1/captures/discard
{ person_id, client_document_id, captured_at, page_count,
  reason: 'user_discarded'|'terminal_error', detail: string|null }
→ { recorded: true }
```
requirePersonAccess(editor)。幂等:同 `client_document_id` 重复上报只写一条(以 journal 内 `client_document_id` 去重,回放侧同样按 event_id 幂等)。

## 7. 存储配额

- 入队前 `navigator.storage.estimate()`;剩余 < 3× 待写字节 → 拒绝拍照并提示"请先联网上传已有队列"。
- 写入抛 `QuotaExceededError` → **不静默丢**:UI 红色告警 + 保留已成功入队的项。
- 提供"仅在 Wi-Fi 上传"开关?**M1 不做**(个人使用,复杂度不划算)。

## 8. 多标签页

用 Web Locks(`navigator.locks.request('amr-upload-queue', ...)`)保证同一时刻只有一个标签页在推进队列;不支持 Web Locks 的环境退化为"每个标签页各自推进",由服务端幂等键兜底(不会产生重复文档)。

## 9. 不变式(实现期以断言检查)

| 不变式 | 说明 |
|---|---|
| `client_document_id` 生成后永不变 | 幂等锚点 |
| `done` ⇒ 该项 blob 已删且元数据已删 | 同事务 |
| 非 `done` ⇒ blob 完整存在 | 否则重试会上传空内容 |
| 任一时刻 `state` ∈ 枚举 | 崩溃恢复时把 `uploading`/`registering` 一律**回退为 `pending`**(重跑安全,由服务端幂等兜底) |
| 队列项数 = UI 显示的待上传数 | 用户信任的直接来源 |
