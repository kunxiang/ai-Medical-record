# 04 · 存储布局

## 0. 首要原则

> **档案要能活得比这个应用久。**

五年后代码可能烂了、依赖装不上、你懒得维护了。那时用任何一个 S3 客户端(甚至 `rclone ls`)打开桶,应该仍然能看懂里面是什么、找到想要的东西。

由此推出三条硬约束:

1. **原件不进数据库 blob**,以对象形式独立存放
2. **每个对象旁边有同名 sidecar JSON**,自描述、可离线解读
3. **key 结构人类可读**,不是一串 UUID

数据库和检索索引是**可从 S3 完整重建的缓存**。索引可以重建,原件不能。

---

## 1. Key 布局

```
s3://<bucket>/
│
├── people/
│   └── {person_slug}/                       # p3f7a2 —— ASCII、短、永不改变
│       ├── _person.json                     # 姓名/生日/性别 的离线可读副本
│       │
│       └── {YYYY}/
│           └── {YYYY-MM-DD}__{facility}__{doctype}__{doc_short_id}/
│               ├── document.json            # ★ 文档级 sidecar
│               ├── page-01.jpg              # ★ 原件,写入后永不修改
│               ├── page-01.json             # 页级 sidecar(sha256/尺寸/EXIF)
│               ├── page-02.jpg
│               ├── page-02.json
│               ├── audio/
│               │   ├── q_fasting.m4a        # ★ 原始录音,永不删除
│               │   └── q_fasting.json       # 转写与元数据
│               └── extractions/
│                   ├── v001.json            # 版本化提取结果
│                   └── v002.json
│
├── derivatives/                             # 缩略图/预览 —— 纯派生,可随时重建
│   └── {person_slug}/{doc_short_id}/
│       ├── thumb-01.webp
│       └── preview-01.webp
│
└── _index/
    ├── people.json                          # slug → 姓名 映射表
    └── manifests/
        └── {YYYY-MM}.jsonl                  # 每月增量清单,灾难恢复用
```

### 目录名示例

```
people/p3f7a2/2024/2024-03-15__xiehe__lab_report__d7k2m9/
people/p3f7a2/2024/2024-03-15__xiehe__prescription__d8n4p1/
people/p9c1e5/2023/2023-11-02__renmin__imaging_report__d2h6r3/
```

**一眼能看出:谁、什么时候、哪家医院、什么类型。** 这正是五年后翻档案时需要的。

### 为什么 key 用 ASCII 而不是中文

S3 key 支持 UTF-8,中文名对浏览更直观。但:

- 部分 SDK 与 CDN 对非 ASCII key 的签名与 URL 编码处理有坑
- 微信小程序等受限环境的兼容性不确定
- 跨系统迁移(rclone、备份脚本、命令行)时转义麻烦

**折中方案:** key 用 ASCII slug,**可读性靠 sidecar 与索引文件补偿**:

- `_index/people.json` 存 `slug → 姓名` 映射
- 每个 person 目录下有 `_person.json`
- 每个文档目录下有 `document.json`,含中文机构名、中文类型、中文摘要

用 `rclone cat` 读一下 JSON 就知道是什么。**兼顾了鲁棒性与可读性。**

### Slug 生成规则

| 类型 | 规则 | 示例 |
|---|---|---|
| `person_slug` | `p` + 5 位 base32(去除易混字符 `0/1/i/l/o/u`) | `p3f7a2` |
| `doc_short_id` | `d` + 5 位 base32 | `d7k2m9` |
| `facility_slug` | 人工维护的拼音短码,未知时用 `unknown` | `xiehe` / `renmin` / `unknown` |

生成后**永不更改**。改名会破坏所有已存在的 key。

---

## 2. Sidecar 规范

### `document.json`

```json
{
  "schema_version": "1.0",
  "document_id": "550e8400-e29b-41d4-a716-446655440000",
  "short_id": "d7k2m9",
  "person": {
    "slug": "p3f7a2",
    "name": "张三",
    "birth_date": "1980-05-12",
    "sex_at_birth": "male"
  },
  "doc_type": "lab_report",
  "doc_type_label": "化验单",
  "facility": { "slug": "xiehe", "name": "北京协和医院", "department": "内分泌科" },
  "dates": {
    "sampled_on": "2024-03-15",
    "reported_on": "2024-03-15",
    "encounter_on": "2024-03-15",
    "captured_at": "2024-03-15T10:32:11+08:00"
  },
  "encounter": {
    "id": "…",
    "type": "outpatient",
    "chief_complaint": "体检发现血脂偏高复查"
  },
  "pages": [
    { "page_no": 1, "file": "page-01.jpg", "sha256": "a3f…", "bytes": 2481920,
      "mime": "image/jpeg", "width": 3024, "height": 4032 }
  ],
  "summary": "生化全项:血脂、肝功、肾功、血糖",
  "source": "camera",
  "uploaded_by": "account-uuid",
  "created_at": "2024-03-15T10:32:45+08:00"
}
```

### `page-NN.json`

```json
{
  "schema_version": "1.0",
  "document_short_id": "d7k2m9",
  "page_no": 1,
  "file": "page-01.jpg",
  "sha256": "a3f2b8…",
  "bytes": 2481920,
  "mime": "image/jpeg",
  "width": 3024, "height": 4032,
  "exif": { "captured_at": "2024-03-15T10:32:11+08:00", "orientation": 1 }
}
```

### `extractions/vNNN.json`

```json
{
  "schema_version": "1.0",
  "version": 2,
  "document_short_id": "d7k2m9",
  "model_id": "claude-opus-5",
  "prompt_version": "extract-lab-report.v3",
  "pipeline_version": "0.4.1",
  "extracted_at": "2024-03-15T10:33:20+08:00",
  "confidence_overall": 0.94,
  "usage": { "input_tokens": 5120, "output_tokens": 1840 },
  "full_text": "北京协和医院 检验报告单\n姓名:张三 性别:男 …",
  "observations": [
    {
      "concept_code": "LDL_C",
      "loinc_code": "13457-7",
      "local_name": "低密度脂蛋白胆固醇",
      "value_raw": "3.62", "value_num": 3.62, "unit_raw": "mmol/L",
      "value_si": 3.62, "unit_si": "mmol/L",
      "ref_low": 0, "ref_high": 3.37,
      "abnormal_flag": "H",
      "specimen": "serum",
      "confidence": 0.97,
      "source_bbox": { "page_no": 1, "x": 0.12, "y": 0.44, "w": 0.63, "h": 0.028 }
    }
  ],
  "consistency_checks": [
    { "rule": "lipid_panel_sum", "passed": true },
    { "rule": "wbc_differential_sum", "passed": false, "detail": "分类和 = 97.2%" }
  ]
}
```

### `_index/people.json`

```json
{
  "schema_version": "1.0",
  "updated_at": "2024-03-15T10:33:20+08:00",
  "people": [
    { "slug": "p3f7a2", "name": "张三", "birth_date": "1980-05-12",
      "sex_at_birth": "male", "relation": "self" },
    { "slug": "p9c1e5", "name": "李四", "birth_date": "1952-08-30",
      "sex_at_birth": "female", "relation": "parent" }
  ]
}
```

### `_index/manifests/{YYYY-MM}.jsonl`

每行一个新增文档,追加写入。用途:**在数据库全丢的情况下重建索引**,无需遍历整个桶。

```jsonl
{"doc_short_id":"d7k2m9","person_slug":"p3f7a2","prefix":"people/p3f7a2/2024/2024-03-15__xiehe__lab_report__d7k2m9/","created_at":"2024-03-15T10:32:45+08:00"}
```

---

## 3. 桶配置

### 必开的两个开关

| 配置 | 设置 | 理由 |
|---|---|---|
| **版本控制 Versioning** | 开启 | 防误删、防误覆盖。便宜且保命 |
| **对象锁 Object Lock (WORM)** | 开启,合规模式,保留期 ≥ 10 年 | 防住代码 bug 或误操作批量删档。对"存一辈子"的原件有意义 |

> 对象锁要在**创建桶时**启用,事后无法开启。如果不确定,宁可先开。

### 存储类别

| 内容 | 类别 | 理由 |
|---|---|---|
| 原件 `page-*.jpg` | 标准 / 低频访问 | 几乎只写不读,但**随时可能要调原图核对** |
| 音频 `audio/*` | 低频访问 | 同上 |
| 缩略图 `derivatives/` | 标准 | 浏览时高频读取 |
| sidecar JSON | 标准 | 小、频繁读 |

⚠️ **不要把原件放深度归档层**(Glacier Deep Archive / 深度冷归档)。取回有小时级延迟和额外费用,而"点开看原图"必须是秒级的。

### 生命周期

- **不设自动删除规则。** 这是永久档案。
- 可设:非当前版本(versioning 产生的旧版)保留 90 天后清理。
- `derivatives/` 可设 180 天未访问转低频 —— 反正能重建。

---

## 4. 成本

先算一笔账,好定基调:

| 项 | 估算 |
|---|---|
| 单张化验单照片 | 2–5 MB |
| 一家五口一年 | 100–300 份文档 ≈ **< 1 GB** |
| 十年 | ≈ 10 GB |
| 存储费用 | **每月几块钱,可忽略** |

**结论:永远不要为了省钱牺牲画质。**

真正的费用在**请求数和出网流量**,不在存储。对策:

- 浏览走缩略图 + CDN,不每次拉原图
- 预签名 URL 设合理有效期,避免重复签发
- 列举操作走数据库,不走 `ListObjects`

### 画质规则

- **存原图,不压缩。** 压缩版只作为派生物。
- 压过头的化验单放大后认不出小数点 —— **你毁掉的是唯一的真相来源**,几年后模型再强也救不回来。
- 客户端上传前**不做有损压缩**;只做 EXIF 方向校正。
- 缩略图(≤ 400px)与预览图(≤ 1600px)在服务端生成,放 `derivatives/`。

---

## 5. 备份

> **云的真正风险不是硬盘,是账号。**

云存储比家里的硬盘可靠得多 —— 但它挂掉的方式通常是欠费停服、账号异常、服务商变更、或你自己误删,而不是磁盘故障。对一份要存几十年的档案,这是**单点**。

### 策略

```
主存储:S3 (versioning + object lock)
   │
   ├── 每日增量同步 ──> 第二处(另一家云 或 家里 NAS)
   └── 每月完整校验 ──> 比对 sha256 清单
```

```bash
# 每日增量
rclone sync s3-primary:medical-record backup-secondary:medical-record \
  --backup-dir backup-secondary:archive/$(date +%F) \
  --transfers 4 --checksum

# 每月校验(比对而非传输)
rclone check s3-primary:medical-record backup-secondary:medical-record --checksum
```

### 恢复演练

**没演练过的备份等于没有备份。** 每半年做一次:

1. 从备份处随机取 5 个文档目录
2. 校验 sha256 与 sidecar 一致
3. 用 `tools/rebuild-index` 从 `_index/manifests/` 重建一个空数据库
4. 确认能检索到、能打开原图

---

## 6. 不变式

写入代码时以断言形式检查:

| 不变式 | 说明 |
|---|---|
| 原件对象写入后**永不覆盖** | 需要修正就写新对象 + 新记录,老的留着 |
| 每个 `page-NN.*` 必有同名 `.json` | |
| 每个文档目录必有 `document.json` | |
| `page-NN.json.sha256` 必须与对象实际 sha256 一致 | 每月校验任务验证 |
| 数据库中的 `storage_key` 必须存在于 S3 | 每月校验任务验证 |
| S3 中每个文档目录必须在数据库有对应记录 | 反向校验,防孤儿 |
| `person_slug` / `doc_short_id` 生成后不变 | |

## 7. 加密(技术权衡,非建议)

| 方案 | 影响 |
|---|---|
| **服务端加密(SSE)** | 对功能零影响。服务端仍可生成缩略图、OCR、建全文索引 |
| **客户端加密** | 服务端拿不到明文 → 无法生成缩略图、无法 OCR、无法建全文索引与语义检索。**所有智能都得搬到客户端** |

这是**功能与隐私的取舍**,由项目所有者决定。此处只陈述代价。
