# 04 · 存储布局

## 0. 首要原则

> **档案要能活得比这个应用久。**

五年后代码可能烂了、依赖装不上、你懒得维护了。那时用任何一个 S3 客户端(甚至 `rclone ls`)打开桶,应该仍然能看懂里面是什么、找到想要的东西。

在此之上,[ADR-045](./adr.md#adr-045) 确立了**三层插件架构**:

| 层 | 内容 | 生命周期 |
|---|---|---|
| **L1 档案层(DMS)** | 原件 + 拍摄事实 + 人工输入 | 10–20 年不淘汰,可整体打包迁移(拷到手机、换平台、换云) |
| **L2 数据处理层** | 提取、转写、归一化、视图 | 持续完善,**可整体重跑替换** |
| **L3 分析层** | 趋势、汇总、AI 分析 | 模型可随时切换(通用大模型 → 专业医学大模型) |

L2/L3 是插件:**升级或替换它们时,L1 的任何字节都不需要动;打包 L1 时,不带走任何 L2/L3 工件。** 本文档的每一条布局决策都必须服从这两句话。

由此推出的硬约束:

1. **原件不进数据库 blob**,以对象形式独立存放
2. **每个对象旁边有同名事实 sidecar**,自描述、可离线解读
3. **key 结构人类可读**,不是一串 UUID
4. **凡不可再生的(原件、拍摄事实、人工输入)必须落 L1;凡可再生的(AI 产物)必须落 L2 区** —— 一个字节都不许住错地方

数据库和检索索引是**可从 S3 完整重建的缓存**。这句话成立的前提是第 4 条:人工输入随写随导出(journal),而不是等到某个"导出功能"上线。

---

## 1. 权威矩阵:对象 × 层 × 可变性 × 锁 × 打包

**★ 这张表是三层原则的可执行形式。任何新增对象类型必须先在这里登记。**

| 对象 | 层 | 可变性 | 对象锁 | 全量打包 | 单人导出 |
|---|---|---|---|---|---|
| `page-NN.jpg` / `audio/*.m4a` / `context/**` 原件 | L1 | **写后永不改** | ✅ 治理模式 ≥10 年 | 必带 | 必带 |
| `capture.json` / `page-NN.json` / `audio/*.json` | L1 事实 + 人工输入 | 写后永不改 | ✅ 同上 | 必带 | 必带 |
| `correction-NNNN.json`(文档目录内更正) | L1 事实 | **只追加,永不改写已有** | ✅ | 必带 | 必带 |
| `journal/{YYYY-MM}.jsonl`(人工层) | L1 人工 | 只追加(条件写) | ✅ | 必带 | 必带 |
| `_person.json` | L1 快照 | 重写式(每次编辑写新版) | ❌(靠 versioning) | 必带 | 必带 |
| `_index/manifests/*.jsonl` | L1 清单 | 只追加(条件写) | ✅ | 必带 | 过滤后带 |
| `_index/decisions/*.jsonl` | 人工(全家共享词表) | 只追加 | ✅ | 必带 | 分类后带(见 §6) |
| `_index/people.json` / `_index/audit/*.jsonl` | L1 | 重写式 / 只追加 | ❌ / ✅ | 必带 | 过滤后带 |
| `_meta/schemas/**`、`_meta/registries/**` | 自述 | 只追加 | ❌ | 必带 | 必带 |
| `_meta/README.md` | 自述 | 重写式(工具生成) | ❌ | 必带 | 必带 |
| `_incoming/**`(直传暂存,spec m0-06) | 暂存 | 短命(lifecycle 7 天含非当前版本) | ❌ | 不带 | 不带 |
| `_probe/**`(启动自检探针,spec m0-04) | 自检 | 重写式;lock-probe 留置 | ❌(lock-probe 例外:最短保留) | 不带 | 不带 |
| `derived/**`(提取、转写、AI 元数据、缩略图、视图) | **L2** | 随时重写/删除 | **❌ 严禁上锁** | **可丢** | 可丢 |

两条铁律:

- **锁不用桶级默认保留期。** 由应用在写入时对上表 ✅ 的对象**逐对象**设置保留;否则可再生的 L2 工件每重跑一次就永久沉积一个十年删不掉的版本。
- **JSONL 追加 = 读-改-写整对象**,S3 无原子追加。所有"只追加"对象必须用**条件写**(If-Match / etag,失败重读重试),否则并发上传会静默丢行 —— 丢的若是归人更正行,重建后错误复活。

---

## 2. Key 布局

```
s3://<bucket>/
│
├── _meta/                                   # ★ 自述层:让桶离开应用后仍可解读(ADR-045)
│   ├── README.md                            # 人读:布局说明、manifests 回放规则、journal 事件类型
│   ├── schemas/{schema_version}/            # sidecar/journal 的 JSON Schema 快照
│   └── registries/{YYYY-MM-DD}.json         # doc_type 枚举、concept 注册表、决策类型注册表快照
│
├── people/                                  # ★ L1 档案区
│   └── {person_slug}/                       # p3f7a2 —— ASCII、短、永不改变
│       ├── _person.json                     # person 全量快照:姓名/生日/性别/血型/过敏史/
│       │                                    #   慢性病/各医院卡号(identifiers)。编辑即重写
│       ├── journal/
│       │   └── {YYYY-MM}.jsonl              # ★ 人工层 journal:问答全部答案类型、手动血压体重、
│       │                                    #   监控组定义、observation 修正/确认、归人裁决、
│       │                                    #   encounter 编辑 —— 随写随追加,与数据库双写
│       ├── context/
│       │   └── {session_id}/                # 不挂文档的会话原件(当晚补录医嘱的录音、拍药盒的照片)
│       │       ├── q_doctor_advice.m4a
│       │       └── q_doctor_advice.json     # 录音事实(时长/sha256/question_key/模板版本)
│       │
│       └── {YYYY}/
│           └── {capture_date}__{doc_short_id}/   # key 只含拍摄日 + 短 ID(ADR-041)
│               ├── capture.json             # ★ 拍摄事实 sidecar —— 只有事实,没有 AI 观点
│               ├── page-01.jpg              # ★ 原件,写入后永不修改
│               ├── page-01.json             # 页级事实(sha256/尺寸/EXIF)
│               ├── audio/
│               │   ├── q_fasting.m4a        # ★ 现场问答原始录音,永不删除
│               │   └── q_fasting.json       # 录音事实。⚠️ 转写不在这里 —— 转写是 L2 派生物
│               └── correction-0001.json     # 追加式更正(如归人纠正),只增不改
│
├── derived/                                 # L2 派生区 —— 全部可再生,打包可丢,严禁上锁
│   ├── {person_slug}/{doc_short_id}/
│   │   ├── meta.json                        # AI 元数据:doc_type/机构/日期/摘要 + 模型与决策溯源
│   │   ├── extractions/
│   │   │   └── v001-r1.json                 # 版本-轮次化提取结果(ADR-039 每轮一个对象)
│   │   ├── transcripts/
│   │   │   └── q_fasting.v1.json            # ASR 转写,版本化,可重跑
│   │   ├── thumb-01.webp
│   │   └── preview-01.webp
│   └── _views/
│       ├── by-facility.json                 # 机构 → 文档列表(可随时全量重建)
│       └── by-doctype.json
│
└── _index/                                  # 重建入口(灾难恢复的起点)
    ├── people.json                          # slug → 姓名 映射表
    ├── manifests/
    │   └── {YYYY-MM}.jsonl                  # 档案事实事件(add / 归人纠正),条件写追加
    ├── decisions/
    │   └── {YYYY-MM}.jsonl                  # 已确认的归一化决策(人工层,ADR-040)
    └── audit/
        └── {YYYY-MM}.jsonl                  # 系统级审计(person_access 变更等);
                                             #   人工动作的审计随 journal,不重复记
```

### 目录名示例

```
people/p3f7a2/2024/2024-03-15__d7k2m9/
people/p3f7a2/2024/2024-03-15__d8n4p1/
people/p9c1e5/2023/2023-11-02__d2h6r3/
```

### ★ 为什么 key 里没有机构和类型(ADR-041)

早期设计把 `{facility}__{doctype}` 编进 key。审核发现这是**上传链路的死结**:facility 和 doctype 都是 **AI 提取后才知道的**,而上传必须在提取前完成 —— 要么先传后改名(与 WORM 对象锁冲突,原件永不移动),要么阻塞上传等提取(违背"拍完即存档成功")。而且 AI 分类还可能被人工修正,key 却永不能改。

所以 key 只保留**上传时刻就确定且永不变**的两个信息:拍摄日期 + 短 ID。"谁、什么时候"仍在 key 里;"哪家医院、什么类型"的可读性由三层补偿:

1. `derived/{person}/{doc}/meta.json`(中文机构名、类型、摘要 —— L2 观点,带溯源)
2. `derived/_views/` —— 按机构/类型浏览的可重建视图
3. 数据库与检索索引

### ★ 为什么 capture.json 里也没有机构和类型(ADR-045)

同一把刀砍到底。早期的 `document.json` 混装拍摄事实与 AI 观点(doc_type/facility/summary)—— 审核判定这是 L1 最大的污染源:L2 升级重分类时,要么改写 L1 对象(违背不可变),要么不改(sidecar 与真相永久漂移)。

现在一分为二:

- **`capture.json`(L1,WORM)**:只存拍摄时刻的事实 —— 谁拍的、几点拍的、选了哪个人、几页、sha256。这些**在上传瞬间就已确定且永不再变**,所以可以第一时间写入并上锁,不依赖 AI。
- **`derived/.../meta.json`(L2,可重写)**:AI 的全部观点 —— 类型、机构、临床日期、摘要 —— 带模型/决策溯源。分类改判、模型升级,只动这个文件。

**判据一句话:上传瞬间就知道的进 capture.json;AI 提取后才知道的进 meta.json。**

### ⚠️ 归人纠正后,前缀不再等于归属

`person_slug` 烧在 key 里,但归人可被纠正(07 §归人纠正),而原件永不移动。所以:**key 中的 person 是拍摄时刻的断言;权威归属 = manifests 回放结果。** 为了让离线读桶的人也能发现,纠正时必须在该文档目录内追加 `correction-NNNN.json`:

```json
{
  "schema_version": "1.0",
  "seq": 1,
  "kind": "person_reassign",
  "from_person_slug": "p3f7a2",
  "to_person_slug": "p9c1e5",
  "reason": "上传时选错了",
  "corrected_at": "2024-03-16T09:01:00+08:00"
}
```

月度校验必须核对:每个文档的(capture.json + corrections 序列)回放结果 == manifests 回放结果。

### 为什么 key 用 ASCII 而不是中文

S3 key 支持 UTF-8,中文名对浏览更直观。但:

- 部分 SDK 与 CDN 对非 ASCII key 的签名与 URL 编码处理有坑
- 微信小程序等受限环境的兼容性不确定
- 跨系统迁移(rclone、备份脚本、命令行)时转义麻烦

**折中方案:** key 用 ASCII slug,**可读性靠 sidecar 与索引文件补偿**。用 `rclone cat` 读一下 JSON 就知道是什么。

### Slug 生成规则

| 类型 | 规则 | 示例 |
|---|---|---|
| `person_slug` | `p` + 5 位 base32(去除易混字符 `0/1/i/l/o/u`) | `p3f7a2` |
| `doc_short_id` | `d` + 5 位 base32 | `d7k2m9` |
| `facility_slug` | 人工维护的拼音短码,未知时用 `unknown`(只用于 L2 视图,不进 key) | `xiehe` / `unknown` |

生成后**永不更改**。改名会破坏所有已存在的 key。

---

## 3. Sidecar 与 journal 规范

### `capture.json`(L1 · WORM)

```json
{
  "schema_version": "2.0",
  "document_id": "550e8400-e29b-41d4-a716-446655440000",
  "short_id": "d7k2m9",
  "person": { "slug": "p3f7a2", "name": "张三", "confirmed_by": "capture_ui" },
  "captured_at": "2024-03-15T10:32:11+08:00",
  "capture_date": "2024-03-15",
  "source": "camera",
  "uploaded_by": "account-uuid",
  "pages": [
    { "page_no": 1, "file": "page-01.jpg", "sha256": "a3f…", "bytes": 2481920,
      "mime": "image/jpeg", "width": 3024, "height": 4032 }
  ],
  "created_at": "2024-03-15T10:32:45+08:00"
}
```

`pages[].crop`(可选,2.1 起)是**人工确认的裁切角点**(ADR-052):

```json
{ "page_no": 1, "file": "page-01.jpg", "…": "…",
  "crop": { "source": "human",
            "quad": [{"x":0.06,"y":0.04},{"x":0.94,"y":0.05},
                     {"x":0.93,"y":0.96},{"x":0.07,"y":0.95}] } }
```

它符合"上传瞬间就知道的进 capture.json"这条判据 —— 人是在上传前的草稿预览里确认的,
而且它是 ADR-045 明确的 L1 三要素之一(原件 + 拍摄事实 + **人工输入**)。
存的是**角点不是校准图**:校准图是「原件 + 角点」的确定性函数,由 L2 随时重生成;
检测器自己提出的那个框属于机器意见,归 `derived/`(L2,可丢),不进这里。

坐标**归一化到 [0,1] 且定义在按 EXIF Orientation 旋正之后的坐标系**,顺序为
左上、右上、右下、左下。缺省(键不存在)= 未裁。

**版本规则:读接受 `2.0`/`2.1`,写只在真有裁切时才升 `2.1`。** 无条件升版会让
"部署跨越了一次中断上传"的续跑请求算出不同字节,在 WORM 的逐字节比对上炸掉。

没有 doc_type、没有 facility、没有 summary、没有临床日期 —— 那些是 AI 观点,在 `derived/.../meta.json`。

`source='split'` 是唯一的服务端合成来源：拆分文档在新 `short_id` 目录只写自己的
`capture.json`，其 `pages[].file` 使用完整 key 引用源目录原件。原件与 `page-NN.json`
不复制、不移动；因此运行时与重建工具不得从原件 key 的 `doc_short_id` 推断当前页归属。

### `derived/{person}/{doc}/meta.json`(L2 · 可重写)

```json
{
  "schema_version": "1.0",
  "document_short_id": "d7k2m9",
  "doc_type": "lab_report",
  "doc_type_label": "化验单",
  "facility": { "slug": "xiehe", "name": "北京协和医院", "department": "内分泌科" },
  "dates": { "sampled_on": "2024-03-15", "reported_on": "2024-03-15" },
  "summary": "生化全项:血脂、肝功、肾功、血糖",
  "provenance": {
    "model_id": "claude-opus-5", "prompt_version": "classify.v3",
    "decision_ids": ["…"], "generated_at": "2024-03-15T10:33:20+08:00"
  }
}
```

`provenance` 必填 —— 五年后读到它的人必须能知道"这是某个模型某一版的观点",而不是事实。

### `page-NN.json` / `audio/*.json`(L1 · WORM,只有事实)

```json
{ "schema_version": "2.0", "document_short_id": "d7k2m9", "page_no": 1,
  "file": "page-01.jpg", "sha256": "a3f2b8…", "bytes": 2481920,
  "mime": "image/jpeg", "width": 3024, "height": 4032,
  "exif": { "captured_at": "2024-03-15T10:32:11+08:00", "orientation": 1 } }
```

```json
{ "schema_version": "2.0", "document_short_id": "d7k2m9",
  "question_key": "fasting", "question_text_snapshot": "今天抽血前吃过东西吗?",
  "template": "lab-report.v1", "file": "q_fasting.m4a",
  "sha256": "…", "bytes": 182044, "duration_sec": 9.2,
  "recorded_at": "2024-03-15T10:34:02+08:00" }
```

**转写不在音频 sidecar 里** —— 它是 ASR 的可重跑产物,住 `derived/.../transcripts/`,未来模型认得出今天的方言时整层重跑,L1 零字节变动。

### `journal/{YYYY-MM}.jsonl`(L1 · 人工层,ADR-045)

**每一条不可再生的人工输入,写数据库的同一事务内追加到这里。** 不是"导出功能",是双写。

```jsonl
{"schema_version":"1.0","event":"context_answer","at":"2024-03-15T10:34:30+08:00","session_id":"…","question_key":"fasting","question_text":"今天抽血前吃过东西吗?","answer_type":"choice","value":"空腹"}
{"schema_version":"1.0","event":"manual_observation","at":"2024-03-16T07:30:00+08:00","concept_code":"BP_SYS","value_num":128,"unit":"mmHg","measurement_setting":"home","device":"欧姆龙U30"}
{"schema_version":"1.0","event":"observation_correct","at":"2024-03-20T21:02:00+08:00","observation_id":"…","field":"value_num","from":8.6,"to":0.86,"reason":"OCR 小数点"}
{"schema_version":"1.0","event":"metric_group_upsert","at":"2024-04-01T20:00:00+08:00","group":{"name":"三高+","items":[{"item_type":"lab","concept_code":"LDL_C"}]}}
{"schema_version":"1.0","event":"person_reassign_resolve","at":"2024-03-16T09:01:00+08:00","doc_short_id":"d7k2m9","resolution":"keep","note":"报告打的是曾用名"}
```

事件类型注册表在 `_meta/README.md` 维护。覆盖范围(设计债 D1 的完整清单):问答**全部**答案类型(点选/数字/文字/日期/照片/语音)、手动 observation(血压/体重)、监控组定义、observation 修正与确认、encounter 编辑、归人裁决及备注、决策状态变更引用、**采集放弃 `capture_discard`(M1)**、**文档归档 `document_archive`(M2)**。

> `capture_discard` 记录"曾经存在过一次拍摄但被放弃" —— 它无法从任何原件重建,不记录就无法解释五年后"那次就诊为什么没有化验单"。

### `_person.json`(L1 · 快照,重写式)

person 表的**全量**离线副本:姓名、生日、性别、血型、**过敏史、慢性病**、note,以及 `identifiers[]`(各医院卡号/病历号/登记号)。每次编辑重写整个文件(versioning 保留历史),同时在 journal 追加 `person_update` 事件。

> 早期版本只存"姓名/生日/性别"三个字段 —— 审核判定为严重缺陷:过敏史是典型的"只有人知道、原件里没有"的不可再生输入,丢失有直接临床危险。

### `extractions/vNNN-rN.json`(L2 · 每轮一个对象)

内容同旧规范(full_text、observations、consistency_checks、usage),仅两处变化:**位置**在 `derived/`(不再污染档案区),**命名**含轮次(ADR-039 的"每轮读数全部留档"落到对象级)。full_text 与原件同**保留策略**(不主动删),但归属 L2、可重跑 —— 它不是原件的同级。

### `_index/manifests/{YYYY-MM}.jsonl`

每行一条**档案事实事件**,只追加、条件写。用途:数据库全丢时重建索引,无需遍历整个桶。

```jsonl
{"op":"add","doc_short_id":"d7k2m9","person_slug":"p3f7a2","prefix":"people/p3f7a2/2024/2024-03-15__d7k2m9/","created_at":"2024-03-15T10:32:45+08:00"}
{"op":"person_correct","doc_short_id":"d7k2m9","to_person_slug":"p9c1e5","created_at":"2024-03-16T09:01:00+08:00"}
```

重放:按时间序,后写覆盖先写。**manifests 只收 L1 事实事件(add、归人纠正)。** 分类改判是 L2 的事,不进 manifests —— 重建时由 L2 自己重算,rebuild 工具不需要理解任何 AI 语义。

---

## 4. 桶配置

| 配置 | 设置 | 理由 |
|---|---|---|
| **Versioning** | 开启 | 防误删、防误覆盖。便宜且保命 |
| **Object Lock** | 桶启用(建桶时,事后无法补),**治理模式**,**不设桶级默认保留期** | 由应用按 §1 矩阵**逐对象**设置 ≥10 年保留。治理而非合规模式(ADR-041):合规模式下拍错的废片将强制保留十年无人能删;治理模式日常同样拦删,持特权凭证可显式绕过 —— 该凭证不进应用,只离线保管 |

⚠️ **不设桶级默认保留期是硬要求**:桶默认会锁住一切新对象,包括每次追加 JSONL 产生的旧版本和可再生的 `derived/**` —— L2 每重跑一次就永久沉积一批十年删不掉的垃圾。

### 存储类别

| 内容 | 类别 | 理由 |
|---|---|---|
| 原件 `page-*.jpg` / 音频 / context | 标准 / 低频访问 | 几乎只写不读,但**随时可能要调原图核对** |
| sidecar / journal / _index / _meta | 标准 | 小、频繁读 |
| `derived/**` | 标准 | 浏览时高频读取 |

⚠️ **不要把原件放深度归档层**(Glacier Deep Archive)。取回有小时级延迟,而"点开看原图"必须是秒级的。

### 生命周期

- **L1 不设任何自动删除规则。** 这是永久档案。被逐对象锁覆盖的版本,生命周期规则也删不掉 —— 这正是期望行为。
- `derived/**` 可设:非当前版本 30 天清理;180 天未访问转低频 —— 反正能重建。
- 追加型 JSONL(journal/manifests/decisions)的非当前版本**不清理** —— 每个版本写入时即被逐对象锁覆盖(追加 = 重写整对象 = 新版本新锁),旧版本自然保留,兼作并发事故取证,量极小。

---

## 5. 打包与迁移(ADR-045)

**"第一层可整体带走"的可执行定义。** 两种形态:

### 全量迁移(换云、换平台、拷到 NAS/手机)

```
必带:people/ + _index/ + _meta/
可丢:derived/          ← 新平台上由 L2 重跑再生
```

目标平台没有 Object Lock / versioning 时,**数据零丢失**(锁是保护机制不是数据),但防误删等级下降 —— 迁移后应立即在新处重建双备份。

### 单人导出(孩子成年带走自己的档案)

```
1. people/{slug}/                          → 整前缀(含 journal、context)
2. _index/manifests/*.jsonl                → 按 person_slug 过滤,含涉及该人的 person_correct 行
   ⚠️ 必须先回放全量 manifests 确定归属,再过滤 —— 直接 cp 前缀会
      带走已改归他人的文档、漏掉改归进来的文档
3. _index/decisions/*.jsonl                → 按决策分类:
      共享词表类(concept_map/unit_identify/facility_map)→ 全量带走(无隐私,是词典)
      个人相关类(pii_identify/encounter_group/person 相关)→ 仅该人的
4. _meta/                                  → 全量带走(schema 与注册表快照是解读档案的钥匙)
```

导出 bundle 的 schema 是 `packages/contracts` 的一部分(07 §导出),不是脚本的即兴发挥。

---

## 6. 成本

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
- 客户端上传前**不做任何改动**:不解码、不重编码、不旋转、不剥 EXIF —— 原件字节零改动。
  > 早期本行写作"只做 EXIF 方向校正",与同段"存原图,不压缩"自相矛盾(方向校正必然重编码 = 有损)。M1 spec 审核裁决:**方向在展示时处理**(派生物用 `sharp.rotate()`,前端用 `image-orientation: from-image`),原件永不改动。
- 缩略图(≤ 400px)与预览图(≤ 1600px)在服务端生成,放 `derived/`。**生成时机:M1 为首次请求时惰性同步生成**(不提前造 M2 的任务队列;派生物按 ADR-045 本就可再生);M2 引入后台队列后可改为预生成,L1 不受影响。

---

## 7. 备份

> **云的真正风险不是硬盘,是账号。**

云存储比家里的硬盘可靠得多 —— 但它挂掉的方式通常是欠费停服、账号异常、服务商变更、或你自己误删,而不是磁盘故障。对一份要存几十年的档案,这是**单点**。

### 策略

```
主存储:S3 (versioning + 逐对象 object lock)
   │
   ├── 每日增量同步 ──> 第二处(另一家云 或 家里 NAS)   ← 只同步 L1:people/ + _index/ + _meta/
   └── 每月完整校验 ──> 比对 sha256 清单
```

```bash
# 每日增量 —— 按 §1 矩阵只备 L1,derived/ 不备(可再生)
for p in people _index _meta; do
  rclone sync s3-primary:medical-record/$p backup-secondary:medical-record/$p \
    --backup-dir backup-secondary:archive/$(date +%F)/$p --transfers 4 --checksum
done

# 每月校验(比对而非传输)
rclone check s3-primary:medical-record/people backup-secondary:medical-record/people --checksum
```

⚠️ 恢复时**绝不回灌**备份里可能残存的旧 `derived/` —— 过期提取结果冒充现役会与重跑后的 L2 冲突。恢复 = 回灌 L1 + 全量重跑 L2。

### 恢复演练

**没演练过的备份等于没有备份。** 每半年做一次:

1. 从备份处随机取 5 个文档目录,校验 sha256 与 capture.json 一致
2. 用 `tools/rebuild-index` 从 `_index/manifests/` + `journal/` 重建一个空数据库
3. **人工层零丢失断言**:抽查问答回答、手动血压、observation 修正(0.86 不得变回 8.6)
4. 确认能检索到、能打开原图
5. 演练"主存储被恶意清空"场景:验证 `--backup-dir` 归档目录里旧数据仍在(同步不是防删,归档目录才是)

---

## 8. 不变式

写入代码时以断言形式检查:

| 不变式 | 说明 |
|---|---|
| §1 矩阵中 WORM 对象写入后**永不覆盖** | 需要修正就追加 correction / 写新对象 |
| `derived/**` 不含任何不可再生数据 | **反向断言**:删光 derived/ 再全量重跑,校验结果一致 |
| 人工输入写库事务内必同步追加 journal | 双写,不是异步导出 |
| 每个 `page-NN.*` 必有同名 `.json`;每个文档目录必有 `capture.json` | |
| `page-NN.json.sha256` 与对象实际 sha256 一致 | 每月校验 |
| 数据库中的 `storage_key` 必须存在于 S3;S3 每个文档目录必须在数据库有记录 | 双向对账,防孤儿 |
| 文档目录(capture + corrections)回放 == manifests 回放 | 归人真相一致性,每月校验 |
| `person_slug` / `doc_short_id` 生成后不变 | |
| JSONL 追加必须条件写 | 并发丢行防护 |
| `_meta/schemas/` 含当前 `schema_version` 的快照 | schema 变更时先落 `_meta` 再上线 |

## 9. 加密(技术权衡,非建议)

| 方案 | 影响 |
|---|---|
| **服务端加密(SSE)** | 对功能零影响。服务端仍可生成缩略图、OCR、建全文索引 |
| **客户端加密** | 服务端拿不到明文 → 无法生成缩略图、无法 OCR、无法建全文索引与语义检索。**所有智能都得搬到客户端** |

这是**功能与隐私的取舍**,由项目所有者决定。此处只陈述代价。
