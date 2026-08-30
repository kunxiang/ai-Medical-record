import { z } from 'zod';
import { IsoDate, IsoDateTime, Sha256Hex, Uuid } from './scalars.js';
import {
  ObservationAbnormalFlag, ObservationExtraDimensions, ObservationResultKind,
  ObservationReviewStatus, ObservationSource, ObservationSourcePage, ObservationTimePrecision,
} from './observation.js';

export const MetricGroupItemType = z.literal('series');
export const MetricGroupPreset = z.enum(['three_high_plus']);

/**
 * A selector is deliberately the complete medical series identity. Leaving a
 * dimension out must mean `null`, never "match anything", so a group cannot
 * silently merge different specimens, methods or measurement settings.
 */
export const MetricSeriesSelector = z.object({
  concept_code: z.string().trim().min(1).max(100),
  qualifier: z.string().trim().max(200).nullable(),
  body_site: z.string().trim().max(200).nullable(),
  specimen: z.string().trim().max(200).nullable(),
  method: z.string().trim().max(300).nullable(),
  device: z.string().trim().max(300).nullable(),
  measurement_setting: z.string().trim().max(100).nullable(),
  extra_dims: ObservationExtraDimensions.nullable(),
  result_kind: ObservationResultKind,
}).strict();

export const MetricGroupItemInput = z.object({
  item_type: MetricGroupItemType.default('series'),
  selector: MetricSeriesSelector,
}).strict();

export const MetricGroupItem = MetricGroupItemInput.extend({
  id: Uuid,
  position: z.number().int().min(0),
  series_selector_hash: Sha256Hex,
}).strict();

export const MetricGroup = z.object({
  id: Uuid,
  person_id: Uuid,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).nullable(),
  preset_origin: MetricGroupPreset.nullable(),
  items: z.array(MetricGroupItem).max(100),
  revision: z.number().int().min(1),
  created_by: Uuid,
  created_at: IsoDateTime,
  updated_by: Uuid,
  updated_at: IsoDateTime,
  archived_at: IsoDateTime.nullable(),
}).strict();

function uniqueSelectors(value: { items: Array<{ selector: unknown }> }, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    const key = JSON.stringify(item.selector);
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'selector'],
        message: '同一监控组不得重复相同 series selector',
      });
    }
    seen.add(key);
  }
}

export const MetricGroupCreateRequest = z.object({
  client_operation_id: Uuid,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).nullable().default(null),
  preset: MetricGroupPreset.nullable().default(null),
  items: z.array(MetricGroupItemInput).min(1).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.preset !== null && value.items !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'preset 与自定义 items 只能选择一种' });
  }
  if (value.preset === null && value.items === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: '必须提供 preset 或至少一个监控项' });
  }
  if (value.items) uniqueSelectors({ items: value.items }, ctx);
});

export const MetricGroupPatchRequest = z.object({
  client_operation_id: Uuid,
  if_revision: z.number().int().min(1),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  items: z.array(MetricGroupItemInput).min(1).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.name === undefined && value.description === undefined && value.items === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少提交一个监控组修改字段' });
  }
  if (value.items) uniqueSelectors({ items: value.items }, ctx);
});

export const MetricGroupArchiveRequest = z.object({
  client_operation_id: Uuid,
  if_revision: z.number().int().min(1),
}).strict();

export const MetricGroupListQuery = z.object({
  person_id: Uuid,
  include_archived: z.union([
    z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true'),
  ]).default(false),
}).strict();

export const MetricGroupListResponse = z.object({ groups: z.array(MetricGroup) }).strict();

export const TrendQuery = z.object({
  id: Uuid,
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(5_000).default(1_000),
  max_points: z.coerce.number().int().min(3).max(2_000).default(300),
}).strict();

export const TrendReference = z.object({
  low: z.number().finite().nullable(),
  high: z.number().finite().nullable(),
  text: z.string().nullable(),
  unit: z.string().nullable(),
}).strict();

export const TrendRcv = z.object({
  previous_observation_id: Uuid,
  change_percent: z.number().finite(),
  threshold_percent: z.number().finite(),
  exceeds: z.boolean(),
  version: z.string(),
}).strict();

export const TrendPoint = z.object({
  observation_id: Uuid,
  observed_on: IsoDate,
  observed_at: IsoDateTime.nullable(),
  time_precision: ObservationTimePrecision,
  value: z.number().finite(),
  value_raw: z.string(),
  unit: z.string().nullable(),
  reference: TrendReference,
  abnormal_flag: ObservationAbnormalFlag.nullable(),
  fact_source: ObservationSource,
  review_status: ObservationReviewStatus,
  series_key: Sha256Hex,
  source_page: ObservationSourcePage.nullable(),
  source_available: z.boolean(),
  calculation_version: z.string().nullable(),
  rcv: TrendRcv.nullable(),
}).strict();

export const TrendLine = z.object({
  line_key: Sha256Hex,
  unit: z.string().nullable(),
  comparable: z.boolean(),
  total_points: z.number().int().min(0),
  downsampled: z.boolean(),
  points: z.array(TrendPoint),
}).strict();

export const TrendSeries = z.object({
  group_item_id: Uuid,
  position: z.number().int().min(0),
  selector: MetricSeriesSelector,
  series_selector_hash: Sha256Hex,
  lines: z.array(TrendLine),
}).strict();

export const TrendOverlay = z.object({
  id: Uuid,
  kind: z.enum(['context_answer', 'medication', 'timeline_event']),
  label: z.string().min(1).max(500),
  occurred_on: IsoDate,
  occurred_at: IsoDateTime.nullable(),
  time_precision: ObservationTimePrecision,
  source_page: ObservationSourcePage.nullable(),
  source_available: z.boolean(),
}).strict();

export const TrendResponse = z.object({
  group: MetricGroup,
  state: z.enum(['empty', 'single', 'trend']),
  total_points: z.number().int().min(0),
  returned_points: z.number().int().min(0),
  downsampled: z.boolean(),
  downsample_version: z.literal('lttb@1').nullable(),
  next_cursor: z.string().nullable(),
  series: z.array(TrendSeries),
  overlays: z.array(TrendOverlay),
}).strict();

export type MetricSeriesSelectorT = z.infer<typeof MetricSeriesSelector>;
export type MetricGroupItemInputT = z.infer<typeof MetricGroupItemInput>;
export type MetricGroupItemT = z.infer<typeof MetricGroupItem>;
export type MetricGroupT = z.infer<typeof MetricGroup>;
export type MetricGroupCreateRequestT = z.infer<typeof MetricGroupCreateRequest>;
export type MetricGroupPatchRequestT = z.infer<typeof MetricGroupPatchRequest>;
export type MetricGroupArchiveRequestT = z.infer<typeof MetricGroupArchiveRequest>;
export type TrendQueryT = z.infer<typeof TrendQuery>;
export type TrendResponseT = z.infer<typeof TrendResponse>;
export type TrendPointT = z.infer<typeof TrendPoint>;
export type TrendLineT = z.infer<typeof TrendLine>;
