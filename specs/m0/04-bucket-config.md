# M0 Spec · 04 桶配置与 `_meta/`

## 1. 建桶(生产与开发一致,开发用 MinIO)

| 配置 | 值 | 验证命令 |
|---|---|---|
| Versioning | Enabled | `aws s3api get-bucket-versioning --bucket $B` → `"Status": "Enabled"` |
| Object Lock | 建桶时启用;**无桶级默认保留期** | `get-object-lock-configuration` → `ObjectLockEnabled: Enabled` 且 **无 `Rule`** |
| 公开访问 | 全部 Block | `get-public-access-block` → 4 项全 true |
| 加密 | SSE(桶默认) | `get-bucket-encryption` 非空 |
| CORS | 仅 PUT 直传所需域 | — |

**桶级默认保留期必须为空**是 ADR-045 硬要求 —— 违反则 L2 重跑永久沉积。`infra/` 提供幂等建桶脚本 `provision-bucket.ts`,以上验证是脚本自检的一部分。

## 2. 逐对象锁参数

| 对象 | Mode | RetainUntilDate |
|---|---|---|
| page 原件 / page json / capture.json / correction / audio | GOVERNANCE | 写入时刻 + 10 年 |
| journal / manifests / decisions 的每个版本 | GOVERNANCE | 写入时刻 + 10 年 |
| `_person.json`、people.json、`_meta/**`、`derived/**` | **不设** | — |

> MinIO 兼容以上全部(含 GOVERNANCE 与条件写)。若目标 S3 兼容实现不支持逐对象锁 → 触发 ADR-045 的后备方案(双桶),**不得**静默降级为无锁。启动时探测:写一个探针对象验证锁与条件写行为,失败即拒绝启动。

## 3. `_meta/` 首版内容(M0 落桶)

```
_meta/README.md                    # 生成自模板:布局说明、manifests 回放规则、
                                   #   journal 事件注册表(M0:person_update)、指向 schemas/
_meta/schemas/2.0/capture.json     # JSON Schema(由 contracts zod 导出 json-schema)
_meta/schemas/2.0/page.json
_meta/schemas/1.0/person.json      # _person.json 的 schema
_meta/schemas/1.0/journal.json     # discriminatedUnion 展开
_meta/schemas/1.0/manifest.json
_meta/registries/<date>.json       # M0:doc_type 枚举 + journal 事件注册表 + slug 字母表
```

规则:**schema 变更 → 先写 `_meta/schemas/<新版本>/` 再上线写入新版本对象**(设计债 D10,CI 断言:代码中的每个 `schema_version` 在 `_meta/schemas/` 有对应文件)。`_meta/README.md` 由 `tools/gen-meta-readme.ts` 从模板 + 注册表生成,禁止手改桶内副本。

## 4. WORM 行为验收(逐条可执行)

```bash
# 1. 覆盖被拒
aws s3api put-object --bucket $B --key $CAPTURE_KEY --body other.json \
  && echo FAIL || echo OK   # 期望:PreconditionFailed(If-None-Match 路径)
# 2. 无特权删除被拒
aws s3api delete-object --bucket $B --key $PAGE_KEY --version-id $VID \
  && echo FAIL || echo OK   # 期望:AccessDenied(governance)
# 3. 特权绕过可行(仅验证一次,证明治理模式选对了)
aws s3api delete-object ... --bypass-governance-retention   # 用离线特权凭证,期望成功
# 4. 应用凭证不含 s3:BypassGovernanceRetention(IAM 策略断言)
```
