# 02 · 仓库结构

## 1. 布局

pnpm workspaces monorepo。`apps/` 是可部署物,`packages/` 是被依赖的库。

```
ai-Medical-record/
├── apps/
│   ├── api/                    # 后端服务(Fastify)—— 唯一持有密钥的进程
│   │   ├── src/
│   │   │   ├── routes/         # HTTP 路由,薄;只做参数校验与调用 modules
│   │   │   ├── modules/        # 业务逻辑
│   │   │   │   ├── person/
│   │   │   │   ├── document/
│   │   │   │   ├── extraction/
│   │   │   │   ├── context/    # 情境问答
│   │   │   │   ├── search/
│   │   │   │   └── export/
│   │   │   ├── ai/             # AI 供应商适配 + prompt 版本管理
│   │   │   │   └── prompts/    # ★ prompt 文件按版本命名,永不原地修改
│   │   │   ├── jobs/           # 后台任务(提取、转写、缩略图、备份校验)
│   │   │   ├── db/             # Drizzle schema + migrations
│   │   │   └── lib/            # 内部工具
│   │   └── test/
│   │
│   ├── web/                    # PWA 移动端
│   │   ├── src/
│   │   │   ├── features/       # 按功能组织:capture / browse / search / trends
│   │   │   ├── offline/        # ★ IndexedDB 队列 + Service Worker(平台特有,不可移植)
│   │   │   ├── api/            # 由 contracts 生成的客户端
│   │   │   └── ui/
│   │   └── public/
│   │
│   ├── mobile/                 # (未来)原生 App
│   └── miniprogram/            # (未来)微信小程序
│
├── packages/
│   ├── contracts/              # ★ API 契约:类型 + Zod schema + 错误码
│   ├── medical/                # ★ 医学执行层:纯函数,零依赖(判断在 AI 决策层,ADR-040)
│   │   ├── src/
│   │   │   ├── concepts/       # 概念查询 API(消费已确认决策的快照;无人工别名表)
│   │   │   ├── units/          # 换算算术(UCUM 码之间);单位识别归 AI 决策层
│   │   │   ├── reference/      # 参考区间处理(按性别/年龄)
│   │   │   ├── variation/      # 生物学变异 CVi / RCV 计算
│   │   │   ├── derived/        # 派生指标:eGFR、non-HDL-C、BMI…
│   │   │   ├── consistency/    # 算术自洽校验规则
│   │   │   └── groups/         # 预置监控组模板(三高等)
│   │   └── data/               # 确认决策的导出快照 + 医学常数(CVi 等);冷启动种子,不手工维护
│   │
│   ├── storage/                # S3 key 生成与解析 + sidecar 序列化
│   └── ui/                     # (未来)跨端组件
│
├── docs/
├── infra/                      # docker-compose、S3 桶策略、备份脚本
└── tools/                      # 一次性脚本:批量导入、重跑提取、备份校验
```

## 2. 依赖规则

这些规则是多平台可移植性的保障,**在 CI 中强制检查**(`dependency-cruiser` 或 ESLint `import/no-restricted-paths`):

```
apps/*        ──依赖──>  packages/*
packages/*    ──不依赖──> apps/*          ❌ 反向依赖一律禁止
packages/medical ──不依赖──> 任何东西      ❌ 零依赖,连 contracts 都不依赖
apps/web      ──不依赖──> apps/api        ❌ 只通过 contracts 通信
```

### `packages/medical` 的纯度契约

这是整个仓库最重要的一条约束:

- ❌ 不做任何 I/O(文件、网络、数据库)
- ❌ 不依赖任何框架、不依赖 Node 内置模块
- ❌ 不含随机数、不读时钟(需要"今天"就从参数传入)
- ✅ 纯函数 + 纯数据

**为什么:** 这一层要能在浏览器、Node、微信小程序、未来的原生 App 里原封不动地跑。任何一个 `import fs` 都会毁掉这个性质。它也是最需要被审阅正确性的代码 —— 纯函数才能被简单地单元测试。

### `packages/contracts` 是唯一的接口真相

所有客户端的类型都从这里来,后端的入参校验也用这里的 Zod schema。**不允许在 app 里手写一份"差不多"的类型。**

```ts
// packages/contracts/src/document.ts
export const DocType = z.enum([
  'lab_report', 'imaging_report', 'prescription', 'discharge_summary',
  'pathology', 'outpatient_note', 'checkup_report', 'ecg',
  'vaccination', 'infusion_order', 'other', 'unknown',
]);
// ★ 单一来源:DB / 分类器 / 问答模板的 doc_type 全部由此导出(ADR-043 注册表)
export type DocType = z.infer<typeof DocType>;
```

## 3. 版本化的资产

三类东西必须版本化,**永不原地修改**。它们都参与了"派生数据可重跑"的能力:

| 资产 | 位置 | 命名 |
|---|---|---|
| 提取 prompt | `apps/api/src/ai/prompts/` | `extract-lab-report.v3.md` |
| 问答模板 | `apps/api/src/modules/context/templates/` | `lab-report.v2.json` |
| 指标字典快照 | `packages/medical/data/` | 从 `normalization_decision` 已确认记录导出,**不手工编辑**(ADR-040) |

改 prompt = 新建一个版本号更高的文件。历史 `extraction` 记录里存的是版本号,所以两年后仍能知道当时用的是哪一版。

## 4. 命名与约定

- 数据库:`snake_case` 表与列
- TypeScript:`camelCase` 变量,`PascalCase` 类型
- API JSON:`snake_case`(与数据库一致,减少映射层)
- 文件:`kebab-case.ts`
- 时间:数据库统一 `timestamptz`,API 统一 ISO 8601 带时区;**日期型字段(如采样日期)用 `date`,不带时区**

## 5. 测试策略

| 层 | 重点 |
|---|---|
| `packages/medical` | **单元测试覆盖率要求最高** —— 单位换算、eGFR、RCV 算错会直接污染医学数据 |
| `packages/storage` | key 生成/解析的往返一致性 |
| `apps/api` | 归人授权(`person_access` 过滤不可绕过)、归档管道端到端 |
| `apps/web` | 离线队列:断网 → 拍照 → 恢复网络 → 确认上传成功 |

另外准备一个**回归样本集**:一批脱敏的化验单图片 + 人工标注的正确答案。每次改 prompt 或换模型,跑一遍比对提取准确率。这是判断"新模型是否真的更好"的唯一可靠方式。

## 6. 首次搭建顺序

1. `packages/contracts` — 先定契约
2. `packages/storage` — key 规范
3. `apps/api` 骨架 + 数据库迁移
4. 归档管道(上传 → S3 → document 记录)
5. `apps/web` 拍照 + 离线队列
6. AI 元数据识别 + 归人确认
7. 检索
8. 其余按 [09 · 路线图](./09-roadmap.md)
