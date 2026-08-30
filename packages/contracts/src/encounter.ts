import { z } from 'zod';
import { Uuid, IsoDate, IsoDateTime } from './scalars.js';
import { EncounterType } from './enums.js';

// 09 要求 contracts 首版含 encounter 类型;M0 无 API(spec m0-01 §4 / 审核 #001 B-4)
export const Encounter = z.object({
  id: Uuid,
  person_id: Uuid,
  encounter_type: EncounterType,
  facility_id: Uuid.nullable(),
  department: z.string().nullable(),
  occurred_on: IsoDate,
  ended_on: IsoDate.nullable(),
  occurred_at: IsoDateTime.nullable(),
  chief_complaint: z.string(),
  diagnosis_text: z.string(),
  doctor_advice: z.string(),
  revision: z.number().int().min(1),
  updated_by: Uuid.nullable(),
  updated_at: IsoDateTime,
  archived_at: IsoDateTime.nullable(),
  created_at: IsoDateTime,
}).strict();

const EncounterFields = z.object({
  encounter_type: EncounterType,
  occurred_on: IsoDate,
  ended_on: IsoDate.nullable().default(null),
  occurred_at: IsoDateTime.nullable().default(null),
  facility_id: Uuid.nullable().default(null),
  department: z.string().trim().max(200).nullable().default(null),
  chief_complaint: z.string().trim().max(2000).default(''),
  diagnosis_text: z.string().trim().max(4000).default(''),
  doctor_advice: z.string().trim().max(4000).default(''),
}).strict();

export const EncounterCreate = EncounterFields.extend({
  client_operation_id: Uuid,
}).strict();

export const EncounterPatch = EncounterFields.partial().extend({
  client_operation_id: Uuid,
  if_revision: z.number().int().min(1),
  archived: z.boolean().optional(),
}).strict();

export const EncounterDocumentsSet = z.object({
  client_operation_id: Uuid,
  if_revision: z.number().int().min(1),
  document_ids: z.array(Uuid).max(200),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.document_ids).size !== value.document_ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['document_ids'], message: 'document_ids 不得重复' });
  }
});

export const EncounterListQuery = z.object({
  person_id: Uuid,
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

export const EncounterListResponse = z.object({
  encounters: z.array(Encounter),
  next_cursor: z.string().nullable(),
}).strict();

export const EncounterDocumentsSetResponse = z.object({
  encounter: Encounter,
  document_ids: z.array(Uuid),
}).strict();

export type EncounterT = z.infer<typeof Encounter>;
export type EncounterCreateT = z.infer<typeof EncounterCreate>;
export type EncounterPatchT = z.infer<typeof EncounterPatch>;
export type EncounterDocumentsSetT = z.infer<typeof EncounterDocumentsSet>;
export type EncounterListResponseT = z.infer<typeof EncounterListResponse>;
