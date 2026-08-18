import { z } from 'zod';
import { Uuid, IsoDate, IsoDateTime, PersonSlug } from './scalars.js';
import { SexAtBirth, RelationToOwner, IdentifierType, IdentifierScope } from './enums.js';

export const Allergy = z.object({
  substance: z.string().min(1),
  reaction: z.string().nullable(),
  severity: z.enum(['mild', 'moderate', 'severe']).nullable(),
  noted_on: IsoDate.nullable(),
});

export const ChronicCondition = z.object({
  name: z.string().min(1),
  icd10: z.string().nullable(),
  diagnosed_on: IsoDate.nullable(),
});

// ★ 无 default 的基底 —— PATCH 从这里派生(spec m0-01 §3 / 审核 #001 #10)
export const PersonFields = z.object({
  display_name: z.string().min(1).max(64),
  name_pinyin: z.string().max(128).nullable(),
  birth_date: IsoDate,
  sex_at_birth: SexAtBirth,
  gender: z.string().max(32).nullable(),
  relation_to_owner: RelationToOwner,
  blood_type: z.string().max(8).nullable(),
  allergies: z.array(Allergy),
  chronic_conditions: z.array(ChronicCondition),
  note: z.string().max(2000),
});

export const PersonCreate = PersonFields.extend({
  name_pinyin: PersonFields.shape.name_pinyin.default(null),
  gender: PersonFields.shape.gender.default(null),
  blood_type: PersonFields.shape.blood_type.default(null),
  allergies: PersonFields.shape.allergies.default([]),
  chronic_conditions: PersonFields.shape.chronic_conditions.default([]),
  note: PersonFields.shape.note.default(''),
});

// JSON Merge Patch:字段缺失 = 不变;显式 null = 置空(仅 nullable 字段)。
// handler 逐键 UPDATE,禁止整对象 spread。
export const PersonUpdate = PersonFields.partial();

export const Person = PersonFields.extend({
  id: Uuid,
  slug: PersonSlug,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  archived_at: IsoDateTime.nullable(),
});

export const PersonIdentifier = z.object({
  id: Uuid,
  facility_id: Uuid.nullable(),
  identifier_type: IdentifierType,
  identifier_value: z.string().min(1).max(64),
  scope: IdentifierScope,
});
export const PersonIdentifierCreate = PersonIdentifier.omit({ id: true });

// ★ sidecar / journal 共用全量快照 —— 与 _person.json 严格同构
//   (含 id 与 identifiers:重建时 person.id 稳定,FK 不漂移;审核 #001 #6/#7)
export const PersonSidecar = Person.extend({
  schema_version: z.literal('1.0'),
  identifiers: z.array(PersonIdentifier),
}).strict();

export const PersonListResponse = z.object({ people: z.array(Person) });

export type PersonT = z.infer<typeof Person>;
export type PersonSidecarT = z.infer<typeof PersonSidecar>;

export type PersonListResponseT = z.infer<typeof PersonListResponse>;
