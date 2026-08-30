import { createHash } from 'node:crypto';
import {
  and, eq, gte, inArray, isNull, lte, ne, sql,
} from 'drizzle-orm';
import {
  ExportInputManifest, ExportPreviewResponse, ExportSelection, canonicalJsonString,
  type ExportInputManifestT, type ExportPreviewResponseT, type ExportSelectionT,
} from '@amr/contracts';
import { db } from '../db/client.js';
import {
  contextAnswer, contextSession, document, documentManualMetadata, documentPage,
  encounter, medication, metricGroup, metricGroupItem, observation, person, timelineEvent,
} from '../db/schema.js';
import { env } from '../env.js';
import { notFound } from '../errors.js';
import { headObject } from '../s3.js';
import {
  VISIT_SUMMARY_FONT_MANIFEST_HASH, VISIT_SUMMARY_RENDERER_ID, VISIT_SUMMARY_RENDERER_VERSION,
} from './font.js';

type Gap = ExportPreviewResponseT['gaps'][number];
type Event = ExportPreviewResponseT['events'][number];

function inRange(value: string | null, selection: ExportSelectionT): boolean {
  if (value === null) return selection.include_undated_events;
  return (!selection.from || value >= selection.from) && (!selection.to || value <= selection.to);
}

function sourceLabel(row: { currentDocumentId: string | null; currentPageNo: number | null }): {
  label: string; available: boolean;
} {
  if (row.currentDocumentId && row.currentPageNo) {
    return { label: `原件 ${row.currentDocumentId.slice(0, 8)} 第 ${row.currentPageNo} 页`, available: true };
  }
  return { label: '人工记录（无原件定位）', available: false };
}

function referenceLabel(row: typeof observation.$inferSelect): string | null {
  if (row.refText) return row.refText;
  if (row.refLow === null && row.refHigh === null) return null;
  const unit = row.refUnit ? ` ${row.refUnit}` : '';
  if (row.refLow !== null && row.refHigh !== null) return `${row.refLow}–${row.refHigh}${unit}`;
  if (row.refLow !== null) return `≥ ${row.refLow}${unit}`;
  return `≤ ${row.refHigh}${unit}`;
}

function valueLabel(row: typeof observation.$inferSelect): string {
  return `${row.valueRaw}${row.unitRaw ? ` ${row.unitRaw}` : ''}`;
}

function comparableValue(row: typeof observation.$inferSelect): { value: number; unit: string } | null {
  if (row.valueSi !== null && row.unitSi) return { value: row.valueSi, unit: row.unitSi };
  if (row.valueNum !== null && row.unitUcum) return { value: row.valueNum, unit: row.unitUcum };
  return null;
}

function metricValue(row: typeof observation.$inferSelect) {
  const source = sourceLabel(row);
  return {
    observation_id: row.id, observed_on: row.observedOn,
    observed_at: row.observedAt?.toISOString() ?? null,
    time_precision: row.timePrecision as 'date' | 'minute' | 'unknown',
    value: valueLabel(row), reference: referenceLabel(row), abnormal_flag: row.abnormalFlag,
    source_label: source.label, source_available: source.available,
  };
}

function changeLabel(
  previous: typeof observation.$inferSelect | null,
  latest: typeof observation.$inferSelect,
): string | null {
  if (!previous) return null;
  if (previous.observedOn === latest.observedOn && (!previous.observedAt || !latest.observedAt)) {
    return '同日仅日期记录，不判断先后或变化';
  }
  const before = comparableValue(previous);
  const after = comparableValue(latest);
  if (!before || !after || before.unit !== after.unit) return '单位或结果类型不可比';
  const delta = after.value - before.value;
  const percent = before.value === 0 ? null : (delta / before.value) * 100;
  return `${delta >= 0 ? '+' : ''}${Number(delta.toFixed(4))} ${after.unit}`
    + (percent === null ? '' : `（${percent >= 0 ? '+' : ''}${Number(percent.toFixed(1))}%）`);
}

function eventSort(left: Event, right: Event): number {
  if (left.occurred_on === null) return right.occurred_on === null
    ? left.source_id.localeCompare(right.source_id) : 1;
  if (right.occurred_on === null) return -1;
  const date = right.occurred_on.localeCompare(left.occurred_on);
  if (date !== 0) return date;
  if (left.occurred_at && right.occurred_at) {
    const precise = right.occurred_at.localeCompare(left.occurred_at);
    if (precise !== 0) return precise;
  } else if (left.occurred_at !== right.occurred_at) {
    // Precise and date-only facts remain explicitly labelled; this is transport order, not a clinical assertion.
    return left.occurred_at ? -1 : 1;
  }
  return left.source_id.localeCompare(right.source_id);
}

function summarizeContext(value: unknown): string | null {
  if (typeof value === 'string') return value.slice(0, 300);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(String).join('、').slice(0, 300);
  return null;
}

export async function buildExportPreview(raw: ExportSelectionT): Promise<ExportPreviewResponseT> {
  const selection = ExportSelection.parse(raw);
  const owner = (await db.select({
    id: person.id, displayName: person.displayName, birthDate: person.birthDate,
    sexAtBirth: person.sexAtBirth, updatedAt: person.updatedAt,
  }).from(person).where(and(eq(person.id, selection.person_id), isNull(person.archivedAt))).limit(1))[0];
  if (!owner) throw notFound();

  const groupConditions = [eq(metricGroup.personId, selection.person_id), isNull(metricGroup.archivedAt)];
  if (selection.metric_group_ids.length > 0) groupConditions.push(inArray(metricGroup.id, selection.metric_group_ids));
  const groups = await db.select().from(metricGroup).where(and(...groupConditions));
  if (selection.metric_group_ids.length > 0
      && groups.length !== new Set(selection.metric_group_ids).size) throw notFound();
  groups.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const items = groups.length === 0 ? [] : await db.select().from(metricGroupItem)
    .where(inArray(metricGroupItem.metricGroupId, groups.map((group) => group.id)))
    .orderBy(metricGroupItem.metricGroupId, metricGroupItem.position, metricGroupItem.id);
  const groupById = new Map(groups.map((group) => [group.id, group]));

  const gaps: Gap[] = [];
  const metrics: ExportPreviewResponseT['metrics'] = [];
  const includedObservationRows: Array<typeof observation.$inferSelect> = [];
  for (const item of items) {
    const conditions = [
      eq(observation.personId, selection.person_id), eq(observation.seriesKey, item.seriesSelectorHash),
      isNull(observation.archivedAt), inArray(observation.reviewStatus, ['confirmed', 'corrected']),
      ne(observation.resultKind, 'input_parameter'),
    ];
    if (selection.from) conditions.push(gte(observation.observedOn, selection.from));
    if (selection.to) conditions.push(lte(observation.observedOn, selection.to));
    const rows = await db.select().from(observation).where(and(...conditions));
    rows.sort((left, right) => (
      left.observedOn.localeCompare(right.observedOn)
      || (left.observedAt?.toISOString() ?? '~').localeCompare(right.observedAt?.toISOString() ?? '~')
      || left.id.localeCompare(right.id)
    ));
    const group = groupById.get(item.metricGroupId)!;
    if (rows.length === 0) {
      gaps.push({
        code: 'no_metric_points', message: `${group.name} / ${item.conceptCode} 在范围内没有确认数据`,
        subject_type: 'metric_group', subject_id: group.id,
      });
      continue;
    }
    includedObservationRows.push(...rows);
    const latest = rows.at(-1)!;
    const previous = rows.at(-2) ?? null;
    metrics.push({
      metric_group_id: group.id, metric_group_name: group.name, group_item_id: item.id,
      series_label: [item.conceptCode, item.qualifier, item.specimen].filter(Boolean).join(' · '),
      latest: metricValue(latest), previous: previous ? metricValue(previous) : null,
      change: changeLabel(previous, latest),
    });
    if (!latest.currentDocumentId || !latest.currentPageNo) gaps.push({
      code: 'source_unavailable', message: `${item.conceptCode} 最近记录没有可打开的来源页`,
      subject_type: 'observation', subject_id: latest.id,
    });
  }

  const events: Event[] = [];
  const eventRevisions: Array<{ source_type: Event['source_type']; source_id: string; revision: number }> = [];
  let encounterCount = 0;
  let medicationCount = 0;
  let contextCount = 0;
  let timelineCount = 0;
  if (selection.include_events) {
    const encounters = await db.select().from(encounter).where(and(
      eq(encounter.personId, selection.person_id), isNull(encounter.archivedAt),
    ));
    for (const row of encounters) {
      if (!inRange(row.occurredOn, selection)) continue;
      encounterCount += 1;
      eventRevisions.push({ source_type: 'encounter', source_id: row.id, revision: row.revision });
      events.push({
        source_type: 'encounter', source_id: row.id,
        label: `${row.encounterType}${row.department ? ` · ${row.department}` : ''}${row.chiefComplaint ? ` · ${row.chiefComplaint}` : ''}`,
        occurred_on: row.occurredOn, occurred_at: row.occurredAt?.toISOString() ?? null,
        time_precision: row.occurredAt ? 'minute' : 'date', source_label: '就诊记录', source_available: false,
      });
    }

    const medications = await db.select().from(medication).where(and(
      eq(medication.personId, selection.person_id), isNull(medication.archivedAt),
    ));
    for (const row of medications) {
      const canonicalOn = row.kind === 'administered'
        ? row.administeredAt!.toISOString().slice(0, 10) : row.startedOn!;
      if (!inRange(canonicalOn, selection)) continue;
      medicationCount += 1;
      eventRevisions.push({ source_type: 'medication', source_id: row.id, revision: row.revision });
      const source = sourceLabel(row);
      events.push({
        source_type: 'medication', source_id: row.id,
        label: `${row.kind === 'administered' ? '已执行' : '处方'}：${row.nameRaw}`
          + `${row.doseRaw ? ` · ${row.doseRaw}` : ''}${row.route ? ` · ${row.route}` : ''}`,
        occurred_on: canonicalOn,
        occurred_at: row.kind === 'administered' ? row.administeredAt!.toISOString() : null,
        time_precision: row.kind === 'administered' ? 'minute' : 'date',
        source_label: source.label, source_available: source.available,
      });
    }

    const answers = await db.select({
      id: contextAnswer.id, questionText: contextAnswer.questionText,
      questionSnapshot: contextAnswer.questionSnapshot, value: contextAnswer.value,
      eventOn: contextAnswer.eventOn, eventAt: contextAnswer.eventAt,
      timePrecision: contextAnswer.timePrecision, revision: contextAnswer.revision,
    }).from(contextAnswer).innerJoin(contextSession, eq(contextSession.id, contextAnswer.sessionId))
      .where(and(eq(contextSession.personId, selection.person_id), eq(contextAnswer.skipped, false)));
    for (const row of answers) {
      const snapshot = row.questionSnapshot as Record<string, unknown>;
      if (typeof snapshot['timeline_kind'] !== 'string' || !inRange(row.eventOn, selection)) continue;
      contextCount += 1;
      eventRevisions.push({ source_type: 'context_answer', source_id: row.id, revision: row.revision });
      const detail = summarizeContext(row.value);
      events.push({
        source_type: 'context_answer', source_id: row.id,
        label: detail ? `${row.questionText}：${detail}` : row.questionText,
        occurred_on: row.eventOn, occurred_at: row.eventAt?.toISOString() ?? null,
        time_precision: (row.timePrecision ?? (row.eventAt ? 'minute' : row.eventOn ? 'date' : 'unknown')) as Event['time_precision'],
        source_label: '用户情境记录', source_available: false,
      });
    }

    const timeline = await db.select().from(timelineEvent).where(and(
      eq(timelineEvent.personId, selection.person_id), isNull(timelineEvent.archivedAt),
    ));
    for (const row of timeline) {
      if (!inRange(row.occurredOn, selection)) continue;
      timelineCount += 1;
      eventRevisions.push({ source_type: 'timeline_event', source_id: row.id, revision: row.revision });
      const source = sourceLabel(row);
      events.push({
        source_type: 'timeline_event', source_id: row.id, label: row.title,
        occurred_on: row.occurredOn, occurred_at: row.occurredAt?.toISOString() ?? null,
        time_precision: row.timePrecision as Event['time_precision'], source_label: source.label,
        source_available: source.available,
      });
    }
    events.sort(eventSort);
  }

  const docs = await db.select({
    id: document.id, captureDate: document.captureDate, sampledOn: document.sampledOn,
    reportedOn: document.reportedOn, manualSampledOn: documentManualMetadata.sampledOn,
    manualReportedOn: documentManualMetadata.reportedOn,
  }).from(document).leftJoin(documentManualMetadata, eq(documentManualMetadata.documentId, document.id))
    .where(and(eq(document.personId, selection.person_id), isNull(document.archivedAt)));
  const selectedDocIds = docs.filter((row) => inRange(
    row.manualSampledOn ?? row.sampledOn ?? row.manualReportedOn ?? row.reportedOn ?? row.captureDate,
    selection,
  )).map((row) => row.id);
  const pageRows = selectedDocIds.length === 0 ? [] : await db.select().from(documentPage)
    .where(inArray(documentPage.documentId, selectedDocIds))
    .orderBy(documentPage.documentId, documentPage.pageNo);
  const originals = await Promise.all(pageRows.map(async (row) => ({
    document_id: row.documentId, page_id: row.id, page_no: row.pageNo, storage_key: row.storageKey,
    content_sha256: row.contentSha256, byte_size: row.byteSize, mime_type: row.mimeType,
    available: (await headObject(row.storageKey)) !== null,
  })));
  for (const original of originals) {
    if (!original.available) gaps.push({
      code: 'original_missing', message: `原件 ${original.document_id.slice(0, 8)} 第 ${original.page_no} 页不可用`,
      subject_type: 'document', subject_id: original.document_id,
    });
    if (selection.format === 'png' && selection.include_originals && original.mime_type === 'application/pdf') {
      gaps.push({
        code: 'original_unsupported', message: 'PNG 摘要不能附加 PDF 原件；请选择 PDF 格式或取消原件附录',
        subject_type: 'document', subject_id: original.document_id,
      });
    }
  }
  const originalBytes = originals.reduce((sum, item) => sum + item.byte_size, 0);
  const originalTooLarge = selection.include_originals
    && (originalBytes > env.exports.maxOriginalBytes || originals.length > env.exports.maxOriginalPages);
  const unsupportedOriginal = gaps.some((gap) => gap.code === 'original_unsupported');

  const revisionVector = {
    selection,
    person: { id: owner.id, updated_at: owner.updatedAt.toISOString() },
    groups: groups.map((group) => ({ id: group.id, revision: group.revision, updated_at: group.updatedAt.toISOString() })),
    items: items.map((item) => ({ id: item.id, hash: item.seriesSelectorHash, position: item.position })),
    observations: includedObservationRows.map((row) => ({ id: row.id, revision: row.revision })),
    events: {
      revisions: eventRevisions.sort((left, right) => (
        left.source_type.localeCompare(right.source_type) || left.source_id.localeCompare(right.source_id)
      )),
      canonical: events,
    },
    originals: originals.map((item) => ({ page_id: item.page_id, sha256: item.content_sha256 })),
  };
  const sourceRevisionHash = createHash('sha256').update(canonicalJsonString(revisionVector)).digest('hex');
  const response = ExportPreviewResponse.parse({
    selection,
    person: { id: owner.id, display_name: owner.displayName, birth_date: owner.birthDate, sex_at_birth: owner.sexAtBirth },
    counts: {
      metric_groups: groups.length, metric_series: metrics.length,
      observations: includedObservationRows.length, encounters: encounterCount,
      medications: medicationCount, context_events: contextCount, timeline_events: timelineCount,
      undated_events: events.filter((item) => item.occurred_on === null).length,
      original_documents: new Set(originals.map((item) => item.document_id)).size,
      original_pages: originals.length,
    },
    metrics, events, gaps, originals, original_bytes_estimate: originalBytes,
    estimated_pages: 1 + (selection.include_originals ? originals.length : 0),
    source_revision_hash: sourceRevisionHash,
    can_generate: (metrics.length > 0 || events.length > 0) && !originalTooLarge && !unsupportedOriginal,
  });
  return response;
}

export async function buildExportInput(selection: ExportSelectionT): Promise<ExportInputManifestT> {
  const preview = await buildExportPreview(selection);
  const { can_generate: _canGenerate, ...frozenPreview } = preview;
  return ExportInputManifest.parse({
    schema_version: '1.0', ...frozenPreview,
    renderer_id: VISIT_SUMMARY_RENDERER_ID,
    renderer_version: VISIT_SUMMARY_RENDERER_VERSION,
    font_manifest_hash: VISIT_SUMMARY_FONT_MANIFEST_HASH,
  });
}

export function isExportTooLarge(preview: ExportPreviewResponseT): boolean {
  return preview.selection.include_originals
    && (preview.original_bytes_estimate > env.exports.maxOriginalBytes
      || preview.counts.original_pages > env.exports.maxOriginalPages);
}
