# P0–P4 Owner / Device / Doctor Manual Acceptance

状态：待执行  
自动验收基线：`specs/p0-p4-core/RESULTS.md`  
机器可校验记录模板：`manual-evidence.template.json`

## 1. 原则与准备

- 所有 Core 验收必须在 `PROCESSING_MODE=off` 下完成。不得用模型结果代替人工事实，也不得把 provider 可用性记为 Core gate。
- 使用 staging/候选生产构建，记录域名、commit/build、浏览器与设备型号。不要在 Git 中保存姓名、邮箱、share token、原文件名或未脱敏医疗内容。
- 录屏/截图统一放入受控证据存储；JSON 只保存不含 PII 的证据引用和测试者代号。
- 合成样张只用于布局预演，不能关闭 P4-12。P4-12 需要 3–5 名医生和至少 1 份脱敏真实样例，但**不要求 20 份真实单据**。

先生成/复核固定合成样张：

```bash
pnpm core:review-sample
```

- [PDF 合成样张](./evidence/visit-summary-synthetic.pdf)
- [PNG 合成样张](./evidence/visit-summary-synthetic.png)
- [样张来源与 hash](./evidence/provenance.json)

## 2. 统一计时规则

- `duration_seconds` 只计用户需要查看、点击、输入或选择的时间。
- P4-11 的后台渲染/下载等待单独写入 `background_seconds`，不计入 30 秒用户操作门槛。
- 发生误点、返回、改筛选或修正输入时继续计时；系统等待可暂停，但必须留下后台耗时。
- 计时开始与结束必须在录屏或观察记录中可定位；人工四舍五入到 0.1 秒。
- 严格不等号按设计执行：P0-11 `<60s`、P1-10 `<90s`；P2 与 P4-11 为 `≤`。

## 3. Owner 与真机流程

### P0-owner-ui / P0-11

1. 准备一份 tester 已知但不在当前首屏的旧文档，记录其脱敏目标特征。
2. 从“档案”首页开始计时；允许使用 person、日期、类型、科室、encounter 和关键词。
3. 打开正确文档及原件后停止计时，要求 `<60s`。
4. 桌面和手机各检查图片大图、PDF fallback、人工字段编辑、revision conflict 的 base/current/draft 合并。

### P1-6 / P1-10

1. 使用 iOS Safari 或 Android Chrome，进入带录音题的情境模板。
2. 拒绝麦克风权限；确认文字替代始终可见、能保存、刷新后不丢草稿，页面不出现 AI/ASR 失败态。
3. 新开一次计时：采集文档、完成 3 个点选和 2 个文字/语音入口，要求 `<90s`；全部跳过也必须可完成。

### P2-10 desktop / mobile

1. 使用同一份脱敏 10 行结构化表格，桌面与手机分别从空草稿开始。
2. 使用报告级日期/标本/方法继承、TSV/CSV、复制上一行/整列和键盘移动；不得预先注入数据库。
3. 保存并重新打开确认 10 行值、单位、日期精度、series 和来源。
4. 桌面要求 `≤180s`，移动要求 `≤300s`；观察记录确认每行重复字段不超过 2 次。

### P3-owner-ui

在桌面和手机分别检查：0 点 CTA、1 点“不形成趋势”、多点趋势、不可比单位分线、同日仅日期、RCV、来源回链/bbox、来源缺失提示。不得出现 AI 结论或因果解释。

### P4-11 / P4-artifact-review

1. 选择已有数据的 person，在趋势页打开导出；确认没有新增第五个主导航。
2. 从首次点击导出入口开始记录用户操作时间；核对 person、范围、数量、gap、原件估算和公开风险。
3. 生成后下载并成功打开文件时停止用户操作计时；要求 `≤30s`。后台 pending/running 时间另记。
4. PDF 和 PNG 均核对：person、范围、最新值、变化、来源、关键事件、日期未记录、数据缺口和“无医学结论”边界一致。
5. 用 owner 创建/复制/撤销链接；用 editor 验证不可分享、用 viewer 验证只能发现和下载已完成内部历史。

### release-log-redaction

在候选部署实际访问一次内部下载、公开链接、撤销后链接和未知链接。抽查 API/reverse proxy/object-store 日志，确认不包含 share token、person 姓名或原文件名；证据只能保存脱敏查询和结论。

## 4. P4-12 医生可读性

### 样本

- 先用仓库合成样张排练流程与计时器，但不计入正式结果。
- 正式测试使用至少 1 份脱敏真实样例；建议 1–3 份覆盖普通、数据较密、来源缺失三种密度。
- 不要求收集 20 份单据；20 份基线只属于 AI plugin 质量轨。

### 流程

1. 招募 3–5 名医生，以 `doctor-01` 等代号记录，不保存姓名或联系方式。
2. 不讲解版式。展示摘要后立即问：“请指出最新值、相对上次的变化，以及这条数据的来源。”
3. 从样张完整可见开始计时，到医生正确指出三项位置停止；记录到 0.1 秒。
4. 每名医生只写一条汇总成绩；三项必须全部正确。3–5 人的 `locate_seconds` 中位数必须 `≤3s`。
5. 可另记自由反馈，但不得把主观“看起来可以”替代上述量化 gate。

## 5. 记录与机器校验

复制模板到受控结果文件，填写全部 gate 和 3–5 条 `doctor_trials`。正式医生记录的 `sample_kind` 必须是 `deidentified_real`；合成样张会被校验器拒绝为正式证据。

```bash
pnpm core:manual-evidence -- specs/p0-p4-core/evidence/manual-evidence.json
```

只有命令输出 `Manual acceptance: PASS`，并且自动验收仍为绿色，才允许把剩余任务勾选为完成。任何失败都应保留原始结果、创建修复项并重新执行受影响 gate，不得手工改成 PASS。
