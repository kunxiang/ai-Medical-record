import { createHash } from 'node:crypto';
import { and, eq, gte, inArray, isNotNull, isNull, lte, ne } from 'drizzle-orm';
import {
  TrendResponse, canonicalJsonString, type MetricGroupT, type TrendQueryT,
  type TrendResponseT,
} from '@amr/contracts';
import {
  LTTB_VERSION, canonicalUcum, convertToSi, largestTriangleThreeBuckets,
  referenceChangeValue,
} from '@amr/medical';
import { db } from '../db/client.js';
import {
  contextAnswer, contextSession, metricGroup, observation,
} from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { metricGroupOut } from './metric-groups.js';
import { observationOut } from './observations.js';

type ObservationRow = typeof observation.$inferSelect;
type GroupItem = MetricGroupT['items'][number];

type Candidate = {
  item: GroupItem;
  row: ObservationRow;
  cursorKey: string;
};

function pointCursorKey(item: GroupItem, row: ObservationRow): string {
  // `~` puts date-only facts after precise facts on the same date for stable transport
  // ordering only. The response keeps observed_at=null and never asserts clinical order.
  return [
    row.observedOn, row.observedAt?.toISOString() ?? '~',
    String(item.position).padStart(6, '0'), row.id,
  ].join('|');
}

function encodeCursor(key: string): string {
  return Buffer.from(key).toString('base64url');
}

function decodeCursor(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (decoded.split('|').length !== 4) throw new Error('invalid');
    return decoded;
  } catch {
    throw new ApiError('validation_failed', '趋势游标无效');
  }
}

function lineIdentity(row: ObservationRow): {
  key: string; value: number; unit: string | null; comparable: boolean;
} | null {
  if (row.valueSi !== null && row.unitSi) {
    return { key: `si:${row.unitSi}`, value: row.valueSi, unit: row.unitSi, comparable: true };
  }
  if (row.valueNum === null) return null;
  if (row.unitUcum) {
    return { key: `ucum:${row.unitUcum}`, value: row.valueNum, unit: row.unitUcum, comparable: true };
  }
  return {
    key: `unverified:${row.unitRaw ?? ''}`, value: row.valueNum,
    unit: row.unitRaw, comparable: false,
  };
}

function projectedReference(row: ObservationRow, lineUnit: string | null) {
  let low = row.refLow;
  let high = row.refHigh;
  let unit = row.refUnit;
  if (row.valueSi !== null && row.unitSi && row.conceptCode && (low !== null || high !== null)) {
    const refUcum = row.refUnit ? canonicalUcum(row.refUnit) : row.unitUcum;
    const convertedLow = low !== null && refUcum ? convertToSi(row.conceptCode, low, refUcum) : null;
    const convertedHigh = high !== null && refUcum ? convertToSi(row.conceptCode, high, refUcum) : null;
    if ((low === null || convertedLow) && (high === null || convertedHigh)) {
      low = convertedLow?.value ?? null;
      high = convertedHigh?.value ?? null;
      unit = row.unitSi;
    }
  }
  // If the reference cannot be converted to the plotted line, preserve it as report text
  // instead of pretending it shares the chart unit.
  return { low, high, text: row.refText, unit: unit ?? lineUnit };
}

function sameClinicalInstant(left: ObservationRow, right: ObservationRow): boolean {
  if (left.observedOn !== right.observedOn) return false;
  if (!left.observedAt || !right.observedAt) return false;
  return left.observedAt.getTime() === right.observedAt.getTime();
}

function rcvFor(input: {
  conceptCode: string; previous: ObservationRow | null; current: ObservationRow;
  previousValue: number | null; currentValue: number; comparable: boolean;
}) {
  if (!input.comparable || !input.previous || input.previousValue === null
      || input.previousValue === 0 || sameClinicalInstant(input.previous, input.current)
      || (input.previous.observedOn === input.current.observedOn
        && (!input.previous.observedAt || !input.current.observedAt))) return null;
  const definition = referenceChangeValue(input.conceptCode);
  if (!definition) return null;
  const changePercent = ((input.currentValue - input.previousValue) / input.previousValue) * 100;
  return {
    previous_observation_id: input.previous.id,
    change_percent: Number(changePercent.toFixed(2)),
    threshold_percent: definition.rcvPercent,
    exceeds: Math.abs(changePercent) > definition.rcvPercent,
    version: definition.version,
  };
}

function chartX(row: ObservationRow): number {
  return row.observedAt?.getTime() ?? Date.parse(`${row.observedOn}T00:00:00.000Z`);
}

function summarizeContextValue(value: unknown): string | null {
  if (typeof value === 'string') return value.slice(0, 200);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(String).join('、').slice(0, 200);
  return null;
}

async function contextOverlays(personId: string, from?: string, to?: string) {
  const conditions = [
    eq(contextSession.personId, personId), eq(contextAnswer.skipped, false),
    isNotNull(contextAnswer.eventOn),
  ];
  if (from) conditions.push(gte(contextAnswer.eventOn, from));
  if (to) conditions.push(lte(contextAnswer.eventOn, to));
  const rows = await db.select({
    id: contextAnswer.id, questionText: contextAnswer.questionText,
    questionSnapshot: contextAnswer.questionSnapshot, value: contextAnswer.value,
    eventOn: contextAnswer.eventOn, eventAt: contextAnswer.eventAt,
    timePrecision: contextAnswer.timePrecision,
  }).from(contextAnswer).innerJoin(contextSession, eq(contextSession.id, contextAnswer.sessionId))
    .where(and(...conditions)).limit(1_000);
  return rows.flatMap((row) => {
    const snapshot = row.questionSnapshot as Record<string, unknown>;
    if (typeof snapshot['timeline_kind'] !== 'string') return [];
    const detail = summarizeContextValue(row.value);
    return [{
      id: row.id, kind: 'context_answer' as const,
      label: detail ? `${row.questionText}：${detail}` : row.questionText,
      occurred_on: row.eventOn!, occurred_at: row.eventAt?.toISOString() ?? null,
      time_precision: row.timePrecision ?? (row.eventAt ? 'minute' : 'date'),
      source_page: null, source_available: false,
    }];
  }).sort((left, right) => (
    left.occurred_on.localeCompare(right.occurred_on)
    || (left.occurred_at ?? '~').localeCompare(right.occurred_at ?? '~')
    || left.id.localeCompare(right.id)
  ));
}

export async function getMetricGroupTrend(input: TrendQueryT): Promise<TrendResponseT> {
  const groupRow = (await db.select().from(metricGroup)
    .where(and(eq(metricGroup.id, input.id), isNull(metricGroup.archivedAt))).limit(1))[0];
  if (!groupRow) throw notFound();
  const group = await db.transaction((tx) => metricGroupOut(tx, groupRow));
  const all: Candidate[] = [];
  for (const item of group.items) {
    const conditions = [
      eq(observation.personId, group.person_id),
      eq(observation.seriesKey, item.series_selector_hash),
      isNull(observation.archivedAt),
      inArray(observation.reviewStatus, ['confirmed', 'corrected']),
      ne(observation.resultKind, 'input_parameter'),
    ];
    if (input.from) conditions.push(gte(observation.observedOn, input.from));
    if (input.to) conditions.push(lte(observation.observedOn, input.to));
    const rows = await db.select().from(observation).where(and(...conditions));
    for (const row of rows) {
      if (lineIdentity(row)) all.push({ item, row, cursorKey: pointCursorKey(item, row) });
    }
  }
  all.sort((left, right) => left.cursorKey.localeCompare(right.cursorKey));
  const cursor = decodeCursor(input.cursor);
  const eligible = cursor ? all.filter((candidate) => candidate.cursorKey > cursor) : all;
  const page = eligible.slice(0, input.limit);
  const hasMore = eligible.length > page.length;

  const previousByObservationId = new Map<string, ObservationRow | null>();
  const lineTotals = new Map<string, number>();
  const lastByLine = new Map<string, ObservationRow>();
  for (const candidate of all) {
    const identity = lineIdentity(candidate.row)!;
    const lineId = `${candidate.item.id}:${identity.key}`;
    previousByObservationId.set(candidate.row.id, lastByLine.get(lineId) ?? null);
    lastByLine.set(lineId, candidate.row);
    lineTotals.set(lineId, (lineTotals.get(lineId) ?? 0) + 1);
  }

  const byItem = new Map<string, Candidate[]>();
  for (const candidate of page) {
    const current = byItem.get(candidate.item.id) ?? [];
    current.push(candidate);
    byItem.set(candidate.item.id, current);
  }
  let anyDownsampled = false;
  let returnedPoints = 0;
  const series = group.items.map((item) => {
    const lineMap = new Map<string, {
      unit: string | null; comparable: boolean; candidates: Candidate[];
    }>();
    for (const candidate of byItem.get(item.id) ?? []) {
      const identity = lineIdentity(candidate.row)!;
      const current = lineMap.get(identity.key) ?? {
        unit: identity.unit, comparable: identity.comparable, candidates: [],
      };
      current.candidates.push(candidate);
      lineMap.set(identity.key, current);
    }
    const lines = [...lineMap.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([identityKey, line]) => {
        const rawPoints = line.candidates.map((candidate) => {
          const identity = lineIdentity(candidate.row)!;
          const previous = previousByObservationId.get(candidate.row.id) ?? null;
          const previousValue = previous ? lineIdentity(previous)?.value ?? null : null;
          const fact = observationOut(candidate.row);
          return {
            x: chartX(candidate.row), y: identity.value,
            observation_id: fact.id, observed_on: fact.observed_on,
            observed_at: fact.observed_at, time_precision: fact.time_precision,
            value: identity.value, value_raw: fact.value_raw, unit: identity.unit,
            reference: projectedReference(candidate.row, identity.unit),
            abnormal_flag: fact.abnormal_flag, fact_source: fact.source,
            review_status: fact.review_status, series_key: fact.series_key!,
            source_page: fact.source_page,
            source_available: fact.source_page?.source_available ?? false,
            calculation_version: fact.calculation_version,
            rcv: rcvFor({
              conceptCode: item.selector.concept_code, previous, current: candidate.row,
              previousValue, currentValue: identity.value, comparable: line.comparable,
            }),
          };
        });
        const downsampled = rawPoints.length > input.max_points;
        const selected = downsampled
          ? largestTriangleThreeBuckets(rawPoints, input.max_points) : rawPoints;
        anyDownsampled ||= downsampled;
        returnedPoints += selected.length;
        return {
          line_key: createHash('sha256').update(canonicalJsonString({
            series_selector_hash: item.series_selector_hash, identity: identityKey,
          })).digest('hex'),
          unit: line.unit, comparable: line.comparable,
          total_points: lineTotals.get(`${item.id}:${identityKey}`) ?? rawPoints.length,
          downsampled,
          points: selected.map(({ x: _x, y: _y, ...point }) => point),
        };
      });
    return {
      group_item_id: item.id, position: item.position, selector: item.selector,
      series_selector_hash: item.series_selector_hash, lines,
    };
  });
  const overlays = await contextOverlays(group.person_id, input.from, input.to);
  return TrendResponse.parse({
    group, state: all.length === 0 ? 'empty' : all.length === 1 ? 'single' : 'trend',
    total_points: all.length, returned_points: returnedPoints,
    downsampled: anyDownsampled, downsample_version: anyDownsampled ? LTTB_VERSION : null,
    next_cursor: hasMore && page.length > 0 ? encodeCursor(page.at(-1)!.cursorKey) : null,
    series, overlays,
  });
}
