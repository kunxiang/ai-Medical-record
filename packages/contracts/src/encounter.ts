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
  created_at: IsoDateTime,
});
