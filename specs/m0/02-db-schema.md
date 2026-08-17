# M0 Spec · 02 数据库 schema

PostgreSQL 16+,Drizzle 迁移。M0 建 **8 张表**:`account`、`person`、`person_identifier`、`person_access`、`facility`、`encounter`、`document`、`document_page`。字段与 [03 · 数据模型](../../docs/03-data-model.md) §1–3 一致;`facility`/`encounter` 仅建表(M0 无写入路径),为 `document` 的 FK 提供目标,避免后续迁移改 FK。

M0 **不建**:extraction、observation、normalization_decision、context_*、metric_group、medication、audit_log(随各自里程碑)。

## 1. DDL 级规定(Drizzle 表达,语义按此)

```sql
CREATE TABLE account (
  id            uuid PRIMARY KEY,                 -- UUID v7,应用生成
  email         text NOT NULL UNIQUE,             -- citext 语义:存小写,应用层 lower()
  password_hash text NOT NULL,                    -- argon2id
  display_name  text NOT NULL,
  timezone      text NOT NULL DEFAULT 'Asia/Shanghai',  -- IANA 名,校验合法性
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE person (
  id                 uuid PRIMARY KEY,
  slug               text NOT NULL UNIQUE,        -- ^p[alphabet]{5}$,见 03-storage-keys
  display_name       text NOT NULL,
  name_pinyin        text,
  birth_date         date NOT NULL,
  sex_at_birth       text NOT NULL CHECK (sex_at_birth IN ('male','female','unknown')),
  gender             text,
  relation_to_owner  text NOT NULL CHECK (relation_to_owner IN
                       ('self','spouse','parent','child','sibling','other')),
  blood_type         text,
  allergies          jsonb NOT NULL DEFAULT '[]',
  chronic_conditions jsonb NOT NULL DEFAULT '[]',
  note               text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz
);

CREATE TABLE person_identifier (
  id               uuid PRIMARY KEY,
  person_id        uuid NOT NULL REFERENCES person(id),
  facility_id      uuid REFERENCES facility(id),
  identifier_type  text NOT NULL CHECK (identifier_type IN
                     ('patient_id','card_no','medical_record_no','other')),
  identifier_value text NOT NULL,
  scope            text NOT NULL CHECK (scope IN ('long_term','single_visit'))
);
-- 03 的唯一约束 (facility_id, identifier_type, identifier_value) 含 NULL facility:
-- 用唯一索引 + COALESCE 哨兵实现,否则 NULL 逃逸唯一性
CREATE UNIQUE INDEX uq_person_identifier
  ON person_identifier (COALESCE(facility_id,'00000000-0000-0000-0000-000000000000'::uuid),
                        identifier_type, identifier_value);

CREATE TABLE person_access (
  account_id uuid NOT NULL REFERENCES account(id),
  person_id  uuid NOT NULL REFERENCES person(id),
  role       text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, person_id)
);

CREATE TABLE facility (           -- M0 仅建表
  id      uuid PRIMARY KEY,
  name    text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  slug    text NOT NULL,
  city    text,
  level   text
);

CREATE TABLE encounter (          -- M0 仅建表,列全集见 03 §2
  id              uuid PRIMARY KEY,
  person_id       uuid NOT NULL REFERENCES person(id),
  encounter_type  text NOT NULL CHECK (encounter_type IN
                    ('outpatient','inpatient','emergency','checkup','other')),
  facility_id     uuid REFERENCES facility(id),
  department      text,
  occurred_on     date NOT NULL,
  ended_on        date,
  occurred_at     timestamptz,
  chief_complaint text NOT NULL DEFAULT '',
  diagnosis_text  text NOT NULL DEFAULT '',
  doctor_advice   text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document (
  id            uuid PRIMARY KEY,
  short_id      text NOT NULL UNIQUE,             -- ^d[alphabet]{5}$
  person_id     uuid NOT NULL REFERENCES person(id),
  encounter_id  uuid REFERENCES encounter(id),
  doc_type      text NOT NULL DEFAULT 'unknown',  -- M0 恒为 'unknown';CHECK 用 contracts 枚举全集
  doc_type_confidence numeric,
  page_count    int NOT NULL CHECK (page_count >= 1),
  source        text NOT NULL CHECK (source IN
                  ('camera','album','pdf','screenshot','scan','import')),
  original_filename text,
  captured_at   timestamptz NOT NULL,
  capture_date  date NOT NULL,                    -- ★ key 的日期段,折算规则见 03-storage-keys §3
                                                  --   [偏差:vs 03 §3 —— 03 无此列;为 key 可重建性新增,须回写 03]
  -- 以下 AI/提取相关列建出但 M0 恒 NULL:
  sampled_on date, reported_on date, collected_at timestamptz,
  received_at timestamptz, tested_at timestamptz, verified_at timestamptz,
  event_time timestamptz, event_time_source text,
  exam_items jsonb, facility_id uuid REFERENCES facility(id),
  report_no text, accession_no text, visit_no text,
  specimen text, specimen_label text, panel_name text,
  ordering_doctor text, clinical_diagnosis text,
  performed_by text, verified_by_name text,
  report_notes text, report_notes_source text NOT NULL DEFAULT 'report_original',
  column_set jsonb,
  uploaded_by   uuid NOT NULL REFERENCES account(id),
  status        text NOT NULL CHECK (status IN
                  ('uploading','uploaded','needs_person_confirm','ready','failed')),
  client_document_id text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (uploaded_by, client_document_id)        -- 幂等键(07:以 account 为界)
);
CREATE INDEX idx_document_person_captured ON document (person_id, captured_at DESC);

CREATE TABLE document_page (
  id             uuid PRIMARY KEY,
  document_id    uuid NOT NULL REFERENCES document(id),
  page_no        int NOT NULL CHECK (page_no >= 1),
  storage_key    text NOT NULL UNIQUE,
  content_sha256 text NOT NULL,
  byte_size      bigint NOT NULL,
  mime_type      text NOT NULL,
  width int NOT NULL, height int NOT NULL,
  thumb_key      text,
  page_label     text,
  capture_order  int NOT NULL,
  UNIQUE (document_id, page_no)
);
```

## 2. 规定

1. **UUID v7 由应用生成**(库:`uuidv7`),禁止 `gen_random_uuid()` 作默认 —— v4 破坏索引局部性。
2. **枚举用 CHECK 而非 pg enum**:枚举扩容(ADR-043 预期 doc_type 会长)时 `ALTER TABLE … DROP/ADD CONSTRAINT` 一步完成,不需要 pg enum 的类型迁移。CHECK 的值列表**必须**由 contracts 枚举生成(迁移文件中代码生成,CI 断言一致)。
3. **`report_no` 无唯一约束**(设计债 D3:撞号绝不自动拒收 —— 03 里"建议加唯一约束"的说法已被 D3 推翻,以 D3 为准)。
4. 迁移**必须**可从零重放:`pnpm db:migrate` 在空库上跑到当前版本;CI 每次从零建。
5. 所有 FK **不设** `ON DELETE CASCADE` —— 档案系统禁止级联删除,删除必须显式。

## 3. 与 03 的已知偏差(审核员重点核对)

| 偏差 | 理由 |
|---|---|
| `document.capture_date` 新增列 | key 的日期段必须可从 DB 重建(不依赖时区再折算);**待回写 03** |
| `document.client_document_id` 入表 | 07 幂等键需持久化;03 表中未列 —— **待回写 03** |
| `report_no` 不加唯一约束 | D3 明文推翻 03 的建议 |
