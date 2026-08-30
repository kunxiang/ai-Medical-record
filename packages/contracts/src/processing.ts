import { z } from 'zod';
import { IsoDateTime, Sha256Hex, Uuid } from './scalars.js';

/** Core 可见的窄处理协议。供应商、模型和 prompt 都只能出现在插件 provenance。 */
export const ProcessingMode = z.enum(['off', 'assist']);
export const ProcessingCapability = z.enum([
  'document_metadata_suggest',
  'facility_suggest',
  'encounter_suggest',
  'transcribe_audio',
  'observation_suggest',
  'semantic_embed',
]);

export const ProcessingSubjectType = z.enum(['document', 'context_answer', 'person', 'family']);
export const ProcessingJobState = z.enum([
  'pending', 'running', 'done', 'failed', 'needs_human', 'unsupported',
]);
export const ProcessingSuggestionState = z.enum([
  'proposed', 'partially_accepted', 'accepted', 'rejected', 'superseded',
]);

export const ProcessingPluginHeartbeat = z.object({
  plugin_id: z.string().min(1).max(100),
  plugin_version: z.string().min(1).max(100),
  capabilities: z.array(ProcessingCapability),
  last_heartbeat_at: IsoDateTime,
  metadata: z.record(z.unknown()).default({}),
}).strict();

export const ProcessingJobEnvelope = z.object({
  id: Uuid,
  capability: ProcessingCapability,
  target_plugin_id: z.string().min(1).max(100),
  target_plugin_version: z.string().min(1).max(100),
  subject_type: ProcessingSubjectType,
  subject_id: z.string().min(1).max(200),
  person_id: Uuid.nullable(),
  input_revision: z.number().int().min(0),
  input_sha256: Sha256Hex,
  run_generation: z.number().int().min(0),
}).strict().superRefine((job, ctx) => {
  if ((job.subject_type === 'family') !== (job.person_id === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['person_id'],
      message: 'family subject 必须且只能使用 null person_id',
    });
  }
});

export const ProcessingSuggestionProvenance = z.object({
  plugin_id: z.string().min(1).max(100),
  plugin_version: z.string().min(1).max(100),
  provider: z.string().min(1).max(100).nullable(),
  model: z.string().min(1).max(200).nullable(),
  prompt_id: z.string().min(1).max(200).nullable(),
  prompt_version: z.string().min(1).max(100).nullable(),
  artifact_key: z.string().min(1).nullable(),
  artifact_sha256: Sha256Hex.nullable(),
}).strict();

export const ProcessingSuggestionEnvelope = z.object({
  id: Uuid,
  capability: ProcessingCapability,
  subject_type: ProcessingSubjectType,
  subject_id: z.string().min(1).max(200),
  person_id: Uuid.nullable(),
  input_revision: z.number().int().min(0),
  input_sha256: Sha256Hex,
  payload: z.record(z.unknown()),
  provenance: ProcessingSuggestionProvenance,
  created_at: IsoDateTime,
}).strict();

export const CapabilitiesResponse = z.object({
  processing_mode: ProcessingMode,
  core: z.object({
    document_metadata: z.literal(true),
    keyword_search: z.literal(true),
    context: z.literal(true),
    observations: z.literal(true),
    trends: z.literal(true),
    exports: z.literal(true),
  }).strict(),
  assist: z.object({
    available: z.boolean(),
    plugins: z.array(ProcessingPluginHeartbeat),
    capabilities: z.array(ProcessingCapability),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.processing_mode === 'off'
      && (value.assist.available || value.assist.plugins.length > 0 || value.assist.capabilities.length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['assist'],
      message: 'processing_mode=off 时 assist 必须完全不可用',
    });
  }
});

export type ProcessingModeT = z.infer<typeof ProcessingMode>;
export type ProcessingCapabilityT = z.infer<typeof ProcessingCapability>;
export type ProcessingJobEnvelopeT = z.infer<typeof ProcessingJobEnvelope>;
export type ProcessingSuggestionEnvelopeT = z.infer<typeof ProcessingSuggestionEnvelope>;
export type CapabilitiesResponseT = z.infer<typeof CapabilitiesResponse>;

/** provider-neutral 去重键；输入或目标插件版本变化必须产生新 job。 */
export function processingDedupKey(input: {
  capability: ProcessingCapabilityT;
  targetPluginId: string;
  targetPluginVersion: string;
  subjectType: z.infer<typeof ProcessingSubjectType>;
  subjectId: string;
  inputSha256: string;
  runGeneration: number;
}): string {
  return [
    'processing', input.capability,
    `${input.targetPluginId}@${input.targetPluginVersion}`,
    input.subjectType, input.subjectId, input.inputSha256,
    `g${input.runGeneration}`,
  ].map((part) => encodeURIComponent(String(part))).join(':');
}
