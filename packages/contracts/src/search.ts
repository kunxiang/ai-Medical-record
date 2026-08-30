import { z } from 'zod';
import { DocType } from './enums.js';
import { IsoDate, Uuid } from './scalars.js';

export const SearchMode = z.enum(['keyword', 'semantic', 'hybrid']);
export const SearchEntityType = z.enum([
  'document', 'encounter', 'context_answer', 'observation', 'medication', 'timeline_event',
]);
export const SearchCoverage = z.enum(['core_manual', 'core_plus_assist']);

export const SearchQuery = z.object({
  person_id: Uuid,
  q: z.string().trim().min(1).max(100),
  mode: SearchMode.default('keyword'),
  entity_type: SearchEntityType.optional(),
  doc_type: DocType.optional(),
  facility_id: Uuid.optional(),
  department: z.string().trim().max(200).optional(),
  encounter_id: Uuid.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

export const SearchResult = z.object({
  entity_type: SearchEntityType,
  entity_id: Uuid,
  document_id: Uuid.nullable(),
  person_id: Uuid,
  title: z.string(),
  occurred_on: IsoDate.nullable(),
  highlights: z.array(z.string()),
  matched_by: z.array(z.string()),
}).strict();

export const SearchResponse = z.object({
  results: z.array(SearchResult),
  next_cursor: z.string().nullable(),
  coverage: SearchCoverage,
}).strict();

export type SearchQueryT = z.infer<typeof SearchQuery>;
export type SearchEntityTypeT = z.infer<typeof SearchEntityType>;
export type SearchResultT = z.infer<typeof SearchResult>;
export type SearchResponseT = z.infer<typeof SearchResponse>;
