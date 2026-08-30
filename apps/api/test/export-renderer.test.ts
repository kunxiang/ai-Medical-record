import { describe, expect, it } from 'vitest';
import { ExportInputManifest } from '@amr/contracts';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import {
  VISIT_SUMMARY_FONT_MANIFEST_HASH, VISIT_SUMMARY_RENDERER_ID, VISIT_SUMMARY_RENDERER_VERSION,
} from '../src/exports/font.js';
import { renderVisitSummary, visitSummaryLines } from '../src/exports/renderer.js';

const id = (suffix: string) => `018f0000-0000-7000-8000-${suffix.padStart(12, '0')}`;

function manifest(format: 'pdf' | 'png') {
  return ExportInputManifest.parse({
    schema_version: '1.0', renderer_id: VISIT_SUMMARY_RENDERER_ID,
    renderer_version: VISIT_SUMMARY_RENDERER_VERSION,
    font_manifest_hash: VISIT_SUMMARY_FONT_MANIFEST_HASH,
    selection: {
      person_id: id('1'), metric_group_ids: [id('2')], from: '2026-08-01', to: '2026-08-31',
      include_events: true, include_undated_events: true, include_originals: false, format,
    },
    person: { id: id('1'), display_name: '测试患者', birth_date: '1980-02-03', sex_at_birth: 'unknown' },
    counts: {
      metric_groups: 1, metric_series: 1, observations: 2, encounters: 1,
      medications: 1, context_events: 0, timeline_events: 1, undated_events: 1,
      original_documents: 0, original_pages: 0,
    },
    metrics: [{
      metric_group_id: id('2'), metric_group_name: '代谢趋势', group_item_id: id('3'),
      series_label: 'CREATININE',
      latest: {
        observation_id: id('4'), observed_on: '2026-08-28', observed_at: null,
        time_precision: 'date', value: '88 umol/L', reference: '41–81 umol/L',
        abnormal_flag: 'high', source_label: '原件 018f0000 第 1 页', source_available: true,
      },
      previous: null, change: null,
    }],
    events: [{
      source_type: 'medication', source_id: id('5'), label: '处方：阿莫西林 0.5 g',
      occurred_on: '2026-08-20', occurred_at: null, time_precision: 'date',
      source_label: '人工记录（无原件定位）', source_available: false,
    }, {
      source_type: 'timeline_event', source_id: id('6'), label: '既往事件日期待确认',
      occurred_on: null, occurred_at: null, time_precision: 'unknown',
      source_label: '人工记录（无原件定位）', source_available: false,
    }],
    gaps: [], originals: [], original_bytes_estimate: 0, estimated_pages: 1,
    source_revision_hash: 'b'.repeat(64),
  });
}

function crowdedManifest(format: 'pdf' | 'png') {
  const base = manifest(format);
  return ExportInputManifest.parse({
    ...base,
    metrics: Array.from({ length: 12 }, (_, index) => ({
      ...base.metrics[0],
      metric_group_id: id(String(100 + index)),
      group_item_id: id(String(200 + index)),
      metric_group_name: `超长监控组 ${index} ${'指标'.repeat(40)}`,
      series_label: `SERIES-${index}-${'LONG'.repeat(30)}`,
    })),
    events: Array.from({ length: 20 }, (_, index) => ({
      ...base.events[0],
      source_id: id(String(300 + index)),
      label: `关键事件 ${index} ${'详细说明'.repeat(50)}`,
    })),
    gaps: Array.from({ length: 10 }, (_, index) => ({
      code: 'source_unavailable', message: `来源缺口 ${index} ${'说明'.repeat(50)}`,
      subject_type: 'observation', subject_id: id(String(400 + index)),
    })),
  });
}

describe('deterministic visit summary renderer', () => {
  it('gives doctors explicit latest, change, and source scan labels', () => {
    const lines = visitSummaryLines(manifest('pdf')).map((line) => line.text);
    expect(lines).toContain('最新｜88 umol/L　2026-08-28　本报告参考：41–81 umol/L');
    expect(lines).toContain('变化｜仅有一个可用记录，暂不能比较变化');
    expect(lines).toContain('来源｜原件 018f0000 第 1 页');
    expect(lines).toContain('来源｜人工记录（无原件定位） · 原件不可用');
  });

  it.each(['pdf', 'png'] as const)('renders %s with stable bytes and content hash', async (format) => {
    const first = await renderVisitSummary(manifest(format));
    const second = await renderVisitSummary(manifest(format));
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.bytes.length).toBeGreaterThan(1_000);
    expect(format === 'pdf' ? first.bytes.subarray(0, 4).toString() : first.bytes.subarray(1, 4).toString())
      .toBe(format === 'pdf' ? '%PDF' : 'PNG');
  }, 30_000);

  it('keeps a crowded summary on one PDF page without silent overflow', async () => {
    const rendered = await renderVisitSummary(crowdedManifest('pdf'));
    const pdf = await PDFDocument.load(rendered.bytes);
    expect(pdf.getPageCount()).toBe(1);
  }, 30_000);

  it('keeps a crowded PNG summary inside the fixed one-page canvas', async () => {
    const rendered = await renderVisitSummary(crowdedManifest('png'));
    const metadata = await sharp(rendered.bytes).metadata();
    expect(metadata.pages ?? 1).toBe(1);
    expect(metadata.width).toBe(1240);
    expect(metadata.height).toBe(1754);
  }, 30_000);
});
