import { ExportInputManifest, type ExportInputManifestT } from '@amr/contracts';
import {
  VISIT_SUMMARY_FONT_MANIFEST_HASH,
  VISIT_SUMMARY_RENDERER_ID,
  VISIT_SUMMARY_RENDERER_VERSION,
} from './font.js';

const id = (suffix: number) => `018f0000-0000-7000-8000-${String(suffix).padStart(12, '0')}`;

function metric(input: {
  index: number;
  group: string;
  series: string;
  latestValue: string;
  previousValue: string;
  reference: string;
  abnormalFlag: string | null;
  change: string;
}): ExportInputManifestT['metrics'][number] {
  return {
    metric_group_id: id(100 + input.index),
    metric_group_name: input.group,
    group_item_id: id(200 + input.index),
    series_label: input.series,
    latest: {
      observation_id: id(300 + input.index),
      observed_on: '2026-08-20',
      observed_at: null,
      time_precision: 'date',
      value: input.latestValue,
      reference: input.reference,
      abnormal_flag: input.abnormalFlag,
      source_label: '2026-08-20 检验报告 · 第 1 页',
      source_available: true,
    },
    previous: {
      observation_id: id(400 + input.index),
      observed_on: '2026-05-10',
      observed_at: null,
      time_precision: 'date',
      value: input.previousValue,
      reference: input.reference,
      abnormal_flag: null,
      source_label: '2026-05-10 检验报告 · 第 1 页',
      source_available: true,
    },
    change: input.change,
  };
}

/** Synthetic, non-clinical data used only to review the deterministic P4 layout. */
export function visitSummaryReviewSample(format: 'pdf' | 'png'): ExportInputManifestT {
  return ExportInputManifest.parse({
    schema_version: '1.0',
    renderer_id: VISIT_SUMMARY_RENDERER_ID,
    renderer_version: VISIT_SUMMARY_RENDERER_VERSION,
    font_manifest_hash: VISIT_SUMMARY_FONT_MANIFEST_HASH,
    selection: {
      person_id: id(1),
      metric_group_ids: [id(101), id(102), id(103)],
      from: '2026-05-01',
      to: '2026-08-28',
      include_events: true,
      include_undated_events: true,
      include_originals: false,
      format,
    },
    person: {
      id: id(1),
      display_name: '脱敏样例 A',
      birth_date: '1968-05-10',
      sex_at_birth: 'unknown',
    },
    counts: {
      metric_groups: 3,
      metric_series: 3,
      observations: 6,
      encounters: 1,
      medications: 1,
      context_events: 0,
      timeline_events: 1,
      undated_events: 1,
      original_documents: 0,
      original_pages: 0,
    },
    metrics: [
      metric({
        index: 1,
        group: '血糖管理',
        series: '糖化血红蛋白（HbA1c）',
        latestValue: '6.7 %',
        previousValue: '7.1 %',
        reference: '4.0–6.0 %',
        abnormalFlag: 'high',
        change: '较 2026-05-10 下降 0.4 个百分点',
      }),
      metric({
        index: 2,
        group: '血脂管理',
        series: '低密度脂蛋白胆固醇（LDL-C）',
        latestValue: '2.31 mmol/L',
        previousValue: '2.86 mmol/L',
        reference: '<3.40 mmol/L',
        abnormalFlag: null,
        change: '较 2026-05-10 下降 0.55 mmol/L',
      }),
      metric({
        index: 3,
        group: '肾功能',
        series: '肌酐（CREA）',
        latestValue: '88 µmol/L',
        previousValue: '82 µmol/L',
        reference: '57–97 µmol/L',
        abnormalFlag: null,
        change: '较 2026-05-10 上升 6 µmol/L',
      }),
    ],
    events: [
      {
        source_type: 'encounter',
        source_id: id(501),
        label: '门诊复查：内分泌科',
        occurred_on: '2026-08-20',
        occurred_at: null,
        time_precision: 'date',
        source_label: '人工就诊记录',
        source_available: true,
      },
      {
        source_type: 'medication',
        source_id: id(502),
        label: '处方：二甲双胍 0.5 g，每日 2 次',
        occurred_on: '2026-07-12',
        occurred_at: null,
        time_precision: 'date',
        source_label: '2026-07-12 处方 · 第 1 页',
        source_available: true,
      },
      {
        source_type: 'timeline_event',
        source_id: id(503),
        label: '既往药物过敏史，发生日期未记录',
        occurred_on: null,
        occurred_at: null,
        time_precision: 'unknown',
        source_label: '人工记录（无原件定位）',
        source_available: false,
      },
    ],
    gaps: [{
      code: 'source_unavailable',
      message: '一条既往事件未记录日期，且没有可打开的来源原件。',
      subject_type: 'timeline_event',
      subject_id: id(503),
    }],
    originals: [],
    original_bytes_estimate: 0,
    estimated_pages: 1,
    source_revision_hash: 'd'.repeat(64),
  });
}
