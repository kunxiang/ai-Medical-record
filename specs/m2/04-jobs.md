# M2 Spec · 04 后台任务队列与状态查询

## 1. 为什么用 PostgreSQL 而不是消息队列

M2 的作业量是"一个家庭的单据",峰值是集中补跑存量。引入 Redis/RabbitMQ 会多一个必须备份、必须监控、必须在灾难恢复演练里复原的有状态组件,而 `SELECT … FOR UPDATE SKIP LOCKED` 在这个量级上完全够用,且**天然被现有的 DB 备份与重建演练覆盖**。

> 这是决定,不是讨论。实现者**禁止**引入额外的队列中间件。

## 2. 表 `ai_job`

```sql
CREATE TABLE ai_job (
  id                uuid PRIMARY KEY,
  kind              text NOT NULL,          -- 'stage1' | 'facility_normalize' | 'encounter_suggest'
  document_id       uuid REFERENCES document(id),
  person_id         uuid NOT NULL REFERENCES person(id),
  state             text NOT NULL,          -- 见 §3
  attempt           integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  locked_at         timestamptz,
  locked_by         text,                   -- 实例标识,用于排查
  last_error        jsonb,                  -- { stage, code, message, category?, at }
  result_key        text,                   -- S1 工件 key
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aj_kind  CHECK (kind IN ('stage1','facility_normalize','encounter_suggest')),
  CONSTRAINT aj_state CHECK (state IN ('pending','running','done','failed','needs_human','unsupported'))
);
CREATE UNIQUE INDEX uq_ai_job_doc_kind ON ai_job (document_id, kind) WHERE document_id IS NOT NULL;
CREATE INDEX idx_ai_job_ready ON ai_job (state, next_attempt_at) WHERE state = 'pending';
```

1. `uq_ai_job_doc_kind` **必须**存在:同一文档同一类型的作业**只能有一条**。重复投递 **必须** `ON CONFLICT DO NOTHING`,**禁止**产生第二条。
2. `ai_job` 属 **L2**:删库重建后为空,**禁止**因缺少 job 记录而使任何 L1 数据不可用。`rebuild-index` **必须**为缺 `s1_artifact_key` 的文档重新投递 `stage1` 作业(而不是恢复旧 job 行)。

## 3. 状态机

```
        投递
         ↓
      pending ──取件──> running ──成功──> done
         ↑                 │
         │  可重试失败      ├──不可重试──> failed        (请求形状错误等)
         └─────退避────────┤
                           ├──拒绝/超限──> needs_human   (人来看)
                           └──格式不支持──> unsupported  (如超限 PDF)
```

1. 取件 **必须**用 `SELECT … WHERE state='pending' AND next_attempt_at <= now() ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT n`,并在同事务内置 `state='running'`、`locked_at=now()`、`locked_by=$instance`。
2. **僵尸作业回收**:`state='running'` 且 `locked_at < now() - interval '15 minutes'` 的行 **必须**被回收为 `pending` 并 `attempt := attempt + 1`。
   > 没有这条,一次进程崩溃就让作业永久卡在 `running` —— M0 验收里同类问题(`uploading` 卡死)已经付过一次学费。
3. 重试退避 **必须**为全抖动:`min(2^attempt × 1000, 300000) × (0.5 + rand/2)` 毫秒。最大 `attempt` 为 5,超过转 `failed`。
4. `done` / `failed` / `needs_human` / `unsupported` 为终态。**禁止**自动离开终态;重跑**必须**是显式动作(见 §5)。
5. 并发度 **必须**可配置(`AI_JOB_CONCURRENCY`,默认 2),**必须** ≥ 1。

## 4. 投递时机

1. `POST /documents` 登记成功后,**必须**在**同一事务**内投递 `stage1` 作业。
   > 同事务:否则"文档已登记但作业没投递"会静默漏跑,而这种漏跑没有任何信号。
2. 投递**禁止**阻塞登记响应。作业执行在事务提交之后由轮询器取件。
3. PDF 文档同样投递 `stage1`;由 [02](./02-ai-client.md) §3.5 决定走 `document` 块或转 `unsupported`。

## 5. API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/documents/:id/ai` | 该文档的作业状态与 S1 结果摘要 |
| `GET` | `/api/v1/jobs?state=&kind=&limit=&cursor=` | 作业列表(游标分页,与 m1-02 §1 同构) |
| `POST` | `/api/v1/documents/:id/ai/rerun` | 显式重跑;body `{ kind, force_prompt_version? }` |

1. 三个端点 **必须**经 `defineRoute` 注册并通过 `requireDocumentAccess` / `requirePersonAccess`(m0 既有中间件)。越权 **必须**返回 404,且与"不存在"不可区分。
2. `rerun` **必须**:①把既有 job 置回 `pending`、`attempt=0`;②**不删除**旧工件(不同 `prompt_version` 并存,同版本则先删后写)。
3. `rerun` **禁止**跨人批量执行。一次调用只作用于一个文档。批量补跑由 `tools/` 侧脚本负责,不开放为 API。
4. `GET /documents/:id/ai` 的响应 **禁止**包含 `full_text`(避免 PII 经 API 外泄);只返回 `doc_type`、置信度、日期、机构原文、`summary`、job 状态与工件 key。

## 6. 可观测性

1. 每次状态迁移 **必须**留下结构化日志:`job_id`、`kind`、`from`、`to`、`attempt`、`code`。
2. `GET /jobs?state=needs_human` **必须**能一次列出全部待人工处理项 —— 这是 M2 唯一的人工入口,没有它,失败就等于消失。
3. **禁止**把 job 事件写进 journal(L2,不是人的判断)。
