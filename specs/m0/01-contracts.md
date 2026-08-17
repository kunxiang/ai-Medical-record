# M0 Spec · 01 contracts

`packages/contracts` 首版。**这里的 Zod schema 是 API 与 DB 之外的第三份同构真相 —— 由 contracts 单向生成/校验另外两者,不允许手写偏离。**

## 1. 基础标量

```ts
export const Uuid = z.string().uuid().transform(s => s.toLowerCase());  // 存储与比较一律小写
export const SLUG_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';           // 30 字符,无 0/1/i/l/o/u
export const PersonSlug = z.string().regex(/^p[23456789abcdefghjkmnpqrstvwxyz]{5}$/);
export const DocShortId  = z.string().regex(/^d[23456789abcdefghjkmnpqrstvwxyz]{5}$/);

// 真实日历日校验(2026-13-45 必须失败)
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(s => !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
            && new Date(s + 'T00:00:00Z').toISOString().slice(0,10) === s);
export const IsoDateTime = z.string().datetime({ offset: true });
export const Sha256Hex   = z.string().regex(/^[0-9a-f]{64}$/);
```

## 2. 枚举(M0 需要的全部)

```ts
export const SexAtBirth      = z.enum(['male', 'female', 'unknown']);
export const RelationToOwner = z.enum(['self','spouse','parent','child','sibling','other']);
export const IdentifierType  = z.enum(['patient_id','card_no','medical_record_no','other']);
export const IdentifierScope = z.enum(['long_term','single_visit']);
export const AccessRole      = z.enum(['owner','editor','viewer']);
export const DocumentSource  = z.enum(['camera','album','pdf','screenshot','scan','import']);
export const DocumentStatus  = z.enum(['uploading','uploaded','needs_person_confirm','ready','failed']);
export const EncounterType   = z.enum(['outpatient','inpatient','emergency','checkup','other']);
export const MimeType        = z.enum(['image/jpeg','image/png','image/webp','application/pdf']);
  // 匹配规则:精确小写字符串;带参数(';charset=…')或大小写变体一律 422 unsupported_media_type
export const DocType = z.enum([                    // 与 03/06 一致;M0 上传时一律 'unknown'
  'lab_report','imaging_report','prescription','discharge_summary',
  'pathology','outpatient_note','checkup_report','ecg',
  'vaccination','infusion_order','other','unknown',
]);
```

## 3. Person

```ts
export const Allergy = z.object({
  substance: z.string().min(1),
  reaction:  z.string().nullable(),
  severity:  z.enum(['mild','moderate','severe']).nullable(),
  noted_on:  IsoDate.nullable(),
});
export const ChronicCondition = z.object({
  name:         z.string().min(1),
  icd10:        z.string().nullable(),
  diagnosed_on: IsoDate.nullable(),
});

// ★ 无 default 的基底 —— PATCH 从这里派生,default 只出现在 Create
const PersonFields = z.object({
  display_name:      z.string().min(1).max(64),
  name_pinyin:       z.string().max(128).nullable(),
  birth_date:        IsoDate,
  sex_at_birth:      SexAtBirth,
  gender:            z.string().max(32).nullable(),
  relation_to_owner: RelationToOwner,
  blood_type:        z.string().max(8).nullable(),
  allergies:         z.array(Allergy),
  chronic_conditions:z.array(ChronicCondition),
  note:              z.string().max(2000),
});

export const PersonCreate = PersonFields.extend({
  name_pinyin: PersonFields.shape.name_pinyin.default(null),
  gender:      PersonFields.shape.gender.default(null),
  blood_type:  PersonFields.shape.blood_type.default(null),
  allergies:   PersonFields.shape.allergies.default([]),
  chronic_conditions: PersonFields.shape.chronic_conditions.default([]),
  note:        PersonFields.shape.note.default(''),
});

// ★ PATCH = JSON Merge Patch 语义:字段缺失 = 不变;显式 null = 置空(仅 nullable 字段)。
//   基底无 default —— parse 结果只含请求里出现的键,handler 逐键 UPDATE,禁止整对象 spread。
export const PersonUpdate = PersonFields.partial();

export const Person = PersonFields.extend({
  id:          Uuid,
  slug:        PersonSlug,
  created_at:  IsoDateTime,
  updated_at:  IsoDateTime,
  archived_at: IsoDateTime.nullable(),
});

export const PersonIdentifier = z.object({
  id:               Uuid,
  facility_id:      Uuid.nullable(),      // M0 无 facility API,恒 null
  identifier_type:  IdentifierType,
  identifier_value: z.string().min(1).max(64),
  scope:            IdentifierScope,
});
export const PersonIdentifierCreate = PersonIdentifier.omit({ id: true });

// ★ sidecar / journal 共用的全量快照 —— 与 `_person.json` 严格同构(含 id 与 identifiers,
//   id 必须随快照:重建时保持 person.id 稳定,document FK 才不漂移)
export const PersonSidecar = Person.extend({
  schema_version: z.literal('1.0'),
  identifiers: z.array(PersonIdentifier),
});
```

## 4. Document 与上传

```ts
export const PresignFileIn = z.object({
  filename:  z.string().min(1).max(255),
  mime_type: MimeType,
  byte_size: z.number().int().min(1).max(50 * 1024 * 1024),   // 硬上限;③ 以 HeadObject 实测强制(413)
  sha256:    Sha256Hex,
});
export const PresignRequest = z.object({
  person_id: Uuid,
  files:     z.array(PresignFileIn).min(1).max(99),
});
export const PresignResponse = z.object({
  batch_id:     Uuid,
  doc_short_id: DocShortId,               // 此刻预留(见 02 upload_batch)
  uploads: z.array(z.object({
    upload_id:  Uuid,
    url:        z.string().url(),
    method:     z.literal('PUT'),
    headers:    z.record(z.string()),     // 客户端必须原样全带(含 Content-Type 与 x-amz-checksum-sha256)
    expires_at: IsoDateTime,              // 15 分钟
  })),
});

export const PageIn = z.object({
  upload_id: Uuid,
  page_no:   z.number().int().min(1).max(99),
  width:     z.number().int().min(1),     // PDF:首页 MediaBox 宽取整 pt(≥1)
  height:    z.number().int().min(1),
  sha256:    Sha256Hex,
});

export const DocumentCreate = z.object({
  person_id:          Uuid,
  person_confirmed:   z.literal(true),
  batch_id:           Uuid,               // 引用 presign 批次;pages[].upload_id 必须全属于该批次
  source:             DocumentSource,
  captured_at:        IsoDateTime
                        .refine(/* ∈ [2000-01-01T00:00Z, 服务器 now + 24h],越界 400 validation_failed */),
  pages:              z.array(PageIn).min(1).max(99)
                        .refine(ps => new Set(ps.map(p=>p.page_no)).size === ps.length
                                   && Math.min(...ps.map(p=>p.page_no)) === 1
                                   && Math.max(...ps.map(p=>p.page_no)) === ps.length,
                                'page_no 必须为从 1 起的连续序列'),
  client_document_id: z.string().min(8).max(64),
});

export const DocumentPageOut = z.object({
  page_no: z.number().int(), storage_key: z.string(),
  sha256: Sha256Hex, byte_size: z.number().int(),
  mime_type: MimeType, width: z.number().int(), height: z.number().int(),
});
export const DocumentOut = z.object({
  id: Uuid, short_id: DocShortId, person_id: Uuid,
  status: DocumentStatus, doc_type: DocType,
  source: DocumentSource, captured_at: IsoDateTime, capture_date: IsoDate,
  original_filename: z.string().nullable(),
  pages: z.array(DocumentPageOut), created_at: IsoDateTime,
});
```

`Encounter`(仅类型,M0 无 API —— 09 要求 contracts 首版含它):

```ts
export const Encounter = z.object({
  id: Uuid, person_id: Uuid, encounter_type: EncounterType,
  facility_id: Uuid.nullable(), department: z.string().nullable(),
  occurred_on: IsoDate, ended_on: IsoDate.nullable(), occurred_at: IsoDateTime.nullable(),
  chief_complaint: z.string(), diagnosis_text: z.string(), doctor_advice: z.string(),
  created_at: IsoDateTime,
});
```

其余出入参 schema(全部必须存在于 contracts,handler 禁止内联定义):
`LoginRequest {email, password}`、`LoginResponse {access_token}`、`PersonListResponse {people: Person[]}`(M0 不分页,`created_at` 升序 —— `[偏差:vs 07 §0 游标分页;M0 单账号数据量恒小,M1 补]`)、`IdentifierCreateResponse = PersonIdentifier`、`PageUrlResponse {url, expires_at}`。
sidecar 侧:`CaptureSidecar`、`PageSidecar`、`CorrectionSidecar`、`ManifestLine`、`JournalLine`(形状见 03 §4,zod 定义住 contracts,storage 只做序列化)。

## 5. Journal 事件(注册表机制)

```ts
export const JournalPersonUpdate = z.object({
  schema_version: z.literal('1.0'),
  event:          z.literal('person_update'),
  event_id:       Uuid,                 // ★ UUID v7,回放幂等键(blocker #14):重复 event_id 只应用一次
  at:             IsoDateTime,
  by_account_id:  Uuid,
  person:         PersonSidecar,        // 真同构:含 id、identifiers、archived_at
});
export const JournalEvent = z.discriminatedUnion('event', [JournalPersonUpdate]);
// 注册表:后续里程碑向 union 追加;禁止修改已有事件 schema(只能加新 schema_version)
```

**建档、PATCH、identifiers 增删、归档(DELETE)—— 任何令 PersonSidecar 内容变化的操作都必须追加一条 person_update。** 归档不是例外(blocker #16)。

## 6. 错误码(M0 全集)

`[偏差:vs 07 §8 —— 07 有 403 person_access_denied;M0 裁决:无权与不存在一律 404,不泄露档案存在性(05 §3),已回写 07。另 07 的 internal_error 为准,首版 spec 的 internal 废弃]`

| HTTP | code | 场景 |
|---|---|---|
| 400 | `validation_failed` | zod 校验失败(含 captured_at 越界),`details.issues` 附 issues |
| 400 | `person_confirmation_required` | `person_confirmed` 非 true |
| 401 | `unauthenticated` | 无/坏/过期 token;登录失败(不区分原因) |
| 404 | `not_found` | 资源不存在,或存在但无 person_access(不可区分) |
| 409 | `duplicate_client_document_id` | 幂等键冲突且 payload 不同(canonical 序列化比对;相同则 200 返回原文档) |
| 409 | `sha256_mismatch` | 对象实测 sha256 与登记不符 |
| 409 | `upload_consumed` | batch 已被其他 document 消费 |
| 413 | `file_too_large` | HeadObject 实测 ContentLength 超登记值或超 50 MiB |
| 422 | `unsupported_media_type` | mime 不在白名单 / HeadObject 实测 Content-Type 与登记不符 |
| 422 | `upload_incomplete` | upload_id 不存在、已过期(批次 24h)、或对象未完成直传 |
| 429 | `rate_limited` | 登录限流(05 §1) |
| 500 | `internal_error` | 兜底,message 不含内部细节 |

## 7. 硬约束

1. contracts 包零运行时依赖(仅 `zod`)。
2. 所有 schema 同时导出 TS 类型;sidecar/journal schema 另导出 JSON Schema(供 `_meta/schemas/`)。
3. apps/api 全部路由**必须**经 `defineRoute({input, output, handler})` 包装器注册 —— 校验在包装器内单点实施(出参校验生产可关);CI 以 lint/grep 断言无裸注册(99 B7)。
4. 枚举禁止在 contracts 之外重复定义 —— DB CHECK 由 contracts 生成,CI 断言一致(02 §2)。
