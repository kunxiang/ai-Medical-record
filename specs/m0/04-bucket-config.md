# M0 Spec · 04 桶配置与 `_meta/`

审核 #001 修订:补 Lifecycle、按 S3 真实语义重写 WORM 验收、探针断言清单。

## 1. 建桶(生产与开发一致,开发用 MinIO)

| 配置 | 值 | 验证命令(provision-bucket.ts 自检) |
|---|---|---|
| Versioning | Enabled | `get-bucket-versioning` → `"Status": "Enabled"` |
| Object Lock | 建桶时启用;**无桶级默认保留期** | `get-object-lock-configuration` → Enabled 且**无 `Rule`** |
| Lifecycle | 见下表 | `get-bucket-lifecycle-configuration` 与期望 JSON 比对 |
| 公开访问 | 全部 Block | `get-public-access-block` → 4 项全 true |
| 加密 | SSE(桶默认) | `get-bucket-encryption` 非空。**MinIO 需配 KMS**(compose 提供 `MINIO_KMS_SECRET_KEY`);未配环境该断言仅在生产强制(审核 #001 B17) |
| CORS | M0 无浏览器端:空配置 | M1 采集端上线时补 |

Lifecycle 规则(审核 #001 #4/#A-6 —— versioning 桶上"清理"必须同时处理当前与非当前版本):

| 前缀 | 规则 |
|---|---|
| `_incoming/` | Expiration 7 天 + **NoncurrentVersionExpiration 1 天** + AbortIncompleteMultipartUpload 1 天 |
| `derived/` | NoncurrentVersionExpiration 30 天(M0 无写入,规则先立) |
| 其余(L1) | **无任何规则** |

## 2. 逐对象锁参数

| 对象 | Mode | RetainUntilDate |
|---|---|---|
| page 原件 / page json / capture.json / correction / audio | GOVERNANCE | 写入时刻 + 10 年 |
| journal / manifests / decisions 的**每个版本** | GOVERNANCE | 写入时刻 + 10 年(追加即重写,新版本新锁;docs/04 §4 已按此回写) |
| `_person.json`、`_index/people.json`、`_meta/**`、`derived/**`、`_incoming/**`、`_probe/**` | **不设** | — |

已知边界(显式接受,审核 #001 C 档):当前版本被裸 DELETE 遮蔽(delete marker)后,`If-None-Match: *` 语义受影响 —— M0 应用凭证**无 DeleteObject 权限**(IAM 断言见 §4.4),该路径不可达。

## 3. 启动探针(审核 #001 B18)

应用启动时对 `_probe/startup`(不上锁)执行,任一断言失败即拒绝启动:

1. `PutObject + If-None-Match: *`:首次成功,重复 → 412
2. `PutObject + If-Match: <etag>`:匹配成功;错 etag → 412
3. `PutObject` 带 `x-amz-checksum-sha256`:错误校验和 → 400
4. `CopyObject` 到新 key 附 `GOVERNANCE` 锁参数:成功,且 `head-object` 回读 `ObjectLockMode=GOVERNANCE`
5. 对 4 的产物执行无特权 `delete-object --version-id` → AccessDenied
   (此对象即 `_probe/lock-probe`,留置桶内,retention 用**最短可配时长**而非 10 年)

逐对象锁或条件写任一不支持 → 触发 ADR-045 后备方案(双桶),**禁止**静默降级。

## 4. WORM 行为验收(按 S3 真实语义,审核 #001 #3)

> 真实保证是"**版本不可销毁** + 应用条件写纪律",不是"key 不可写"。versioning 桶上裸 PUT 永远成功(产生新版本)、裸 DELETE 永远成功(产生 delete marker)——验收要验的是**旧版本受锁、可发现、可恢复**。

```bash
# 1. 条件写纪律被 S3 强制:对已存在的 capture.json 重复条件 PUT → 412
aws s3api put-object --bucket $B --key $CAPTURE_KEY --body other.json \
  --if-none-match '*' && echo FAIL || echo OK          # 期望 PreconditionFailed
# 2. 裸 PUT 产生新版本,但原版本仍在且受锁
aws s3api put-object --bucket $B --key $CAPTURE_KEY --body other.json   # 成功(这是预期!)
aws s3api list-object-versions --bucket $B --prefix $CAPTURE_KEY        # 两个版本
aws s3api delete-object --bucket $B --key $CAPTURE_KEY --version-id $ORIG_VID \
  && echo FAIL || echo OK                              # 期望 AccessDenied(governance)
# 3. 恢复:删掉污染版本(它未上锁?不——应用写路径外的裸 PUT 无锁),恢复原版本为 current
aws s3api delete-object --bucket $B --key $CAPTURE_KEY --version-id $POLLUTED_VID  # 成功
# 4. 应用凭证 IAM 断言:无 s3:BypassGovernanceRetention、无 s3:DeleteObject(L1 前缀)
# 5. 治理模式特权绕过(仅 C1 人工验证一次):离线凭证 + --bypass-governance-retention → 成功
```

月度对账必须包含:L1 前缀下 `list-object-versions` 扫描 —— 发现 delete marker 或"同 key 多版本"即报警(应用纪律被绕过的证据)。

## 5. `_meta/` 首版内容(M0 落桶)

```
_meta/README.md                    # 生成自 tools/gen-meta-readme.ts:布局、manifests/journal
                                   #   回放规则(event_id 幂等、无佐证 add 进对账)、事件注册表
_meta/schemas/2.0/capture.json     # 由 contracts zod 导出 JSON Schema
_meta/schemas/2.0/page.json
_meta/schemas/1.0/person.json      # PersonSidecar
_meta/schemas/1.0/journal.json
_meta/schemas/1.0/manifest.json
_meta/schemas/1.0/correction.json  # M0 定义、无写入路径(审核 #001 #17)
_meta/registries/<YYYY-MM-DD>.json # 文件名=部署日,同日重复部署幂等覆盖(B16);
                                   #   内容:doc_type 枚举 + journal 事件注册表 + slug 字母表 + mime 白名单
```

`_meta/README.md` 为**重写式**对象(docs/04 矩阵已单列,审核 #001 C-2)。规则:schema 变更 → 先落 `_meta/schemas/<新版本>/` 再上线(D10);CI 断言:代码中出现的每个 `schema_version` 在 `_meta/schemas/` 有对应文件(99 **B8**)。
