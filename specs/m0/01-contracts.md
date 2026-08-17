# M0 Spec · 01 contracts

`packages/contracts` 首版。**这里的 Zod schema 是 API 与 DB 之外的第三份同构真相 —— 由 contracts 单向生成/校验另外两者,不允许手写偏离。**

## 1. 基础标量

```ts
// 所有 id:UUID v7(时间有序,利于索引局部性)。字符串形态,小写。
export const Uuid = z.string().uuid();

// slug 字母表:30 字符,Crockford 风格去混淆(无 0/1/i/l/o/u)
export const SLUG_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
export const PersonSlug = z.string().regex(/^p[23456789abcdefghjkmnpqrstvwxyz]{5}$/);
export const DocShortId  = z.string().regex(/^d[23456789abcdefghjkmnpqrstvwxyz]{5}$/);

export const IsoDate     = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);          // 无时区含义
export const IsoDateTime = z.string().datetime({ offset: true });            // 必须带时区
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

export const PersonCreate = z.object({
  display_name:      z.string().min(1).max(64),
  name_pinyin:       z.string().max(128).nullable().default(null),
  birth_date:        IsoDate,                    // 必填(07 §1)
  sex_at_birth:      SexAtBirth,                 // 必填
  gender:            z.string().max(32).nullable().default(null),
  relation_to_owner: RelationToOwner,
  blood_type:        z.string().max(8).nullable().default(null),
  allergies:         z.array(Allergy).default([]),
  chronic_conditions:z.array(ChronicCondition).default([]),
  note:              z.string().max(2000).default(''),
});

export const Person = PersonCreate.extend({
  id:          Uuid,
  slug:        PersonSlug,      // 服务端生成,响应必含,永不变
  created_at:  IsoDateTime,
  updated_at:  IsoDateTime,
  archived_at: IsoDateTime.nullable(),
});

// PATCH:除 slug/id/created_at 外的全部字段可改,全部可选
export const PersonUpdate = PersonCreate.partial();
```

`PersonIdentifier`:

```ts
export const PersonIdentifierCreate = z.object({
  facility_id:      Uuid.nullable().default(null),   // M0 无 facility API,一律 null
  identifier_type:  IdentifierType,
  identifier_value: z.string().min(1).max(64),
  scope:            IdentifierScope,
});
```

## 4. Document(M0 子集)

M0 的 document 只承载**上传时刻已知的事实**(与 `capture.json` 同构,ADR-045)。AI 观点字段(doc_type 判定、sampled_on 等)在 DB 列上存在(见 02)但 M0 的 API **禁止**接收它们。

```ts
export const PageIn = z.object({
  upload_id: z.string().min(1),
  page_no:   z.number().int().min(1),
  width:     z.number().int().min(1),
  height:    z.number().int().min(1),
  sha256:    Sha256Hex,
});

export const DocumentCreate = z.object({
  person_id:          Uuid,
  person_confirmed:   z.literal(true),         // M0 无批量导入,必须字面量 true
  source:             DocumentSource,
  captured_at:        IsoDateTime,             // 客户端提供(EXIF 优先);服务端仅校验合理性
  pages:              z.array(PageIn).min(1)
                        .refine(ps => new Set(ps.map(p=>p.page_no)).size === ps.length
                                   && Math.min(...ps.map(p=>p.page_no)) === 1
                                   && Math.max(...ps.map(p=>p.page_no)) === ps.length,
                                'page_no 必须为从 1 起的连续序列'),
  client_document_id: z.string().min(8).max(64),   // 幂等键
});
```

## 5. Journal 事件(注册表机制)

```ts
// 每个事件:一个 zod schema + 注册表登记。M0 只有一种。
export const JournalPersonUpdate = z.object({
  schema_version: z.literal('1.0'),
  event:          z.literal('person_update'),
  at:             IsoDateTime,
  by_account_id:  Uuid,
  person:         Person.omit({ id: true }),   // 全量快照(与 _person.json 同构)
});
export const JournalEvent = z.discriminatedUnion('event', [JournalPersonUpdate]);
// 注册表导出:后续里程碑向 union 追加,禁止修改已有事件的 schema(只能加新 schema_version)
```

## 6. 错误码(M0 全集)

响应体格式(07 §8):`{ "error": { "code": string, "message": string, "details"?: object } }`

| HTTP | code | 场景 |
|---|---|---|
| 400 | `validation_failed` | zod 校验失败,`details.issues` 附 zod issues |
| 400 | `person_confirmation_required` | `person_confirmed` 非 true |
| 401 | `unauthenticated` | 无/坏 token |
| 404 | `not_found` | 资源不存在,**或存在但无 person_access**(见 05-auth,不区分) |
| 409 | `duplicate_client_document_id` | 幂等键冲突且 payload 不同(相同则 200 返回原文档) |
| 409 | `sha256_mismatch` | 直传对象的实际 sha256 与登记不符 |
| 422 | `upload_incomplete` | 引用的 upload_id 未完成直传 |
| 500 | `internal` | 兜底,message 不含内部细节 |

## 7. 硬约束

1. contracts 包**必须**零运行时依赖(仅 `zod`)。
2. 所有 schema **必须**同时导出 TS 类型(`z.infer`)。
3. apps/api 的每个路由 handler **必须**以 contracts schema 做入参与出参校验(出参校验开发/CI 开启,生产可关)。
4. 枚举**禁止**在 contracts 之外重复定义 —— DB enum 与 API 文档由此生成或断言一致(02 §4)。
