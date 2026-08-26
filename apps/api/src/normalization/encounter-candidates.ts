import type {
  EncounterCandidateDocumentT, EncounterCandidatePairT, EncounterSuggestionModelOutT,
  EncounterProposalT,
} from '@amr/contracts';
import { uuidv7 } from 'uuidv7';

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function effectiveDate(item: EncounterCandidateDocumentT): string {
  return item.sampled_on ?? item.reported_on ?? item.capture_date;
}

function utcDayStart(value: string): number {
  return Date.parse(`${value}T00:00:00Z`);
}

function calendarDateAt(isoTimestamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(isoTimestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value['year']}-${value['month']}-${value['day']}`;
}

export function pairKey(ids: readonly string[]): string {
  return [...ids].sort().join(':');
}

export function eligibleEncounterPair(
  left: EncounterCandidateDocumentT,
  right: EncounterCandidateDocumentT,
): EncounterCandidatePairT | null {
  if (left.id === right.id || left.facility_id !== right.facility_id) return null;
  const ids = [left.id, right.id].sort() as [string, string];

  if (left.event_time && right.event_time) {
    const difference = Math.abs(Date.parse(left.event_time) - Date.parse(right.event_time));
    return difference <= TWELVE_HOURS_MS
      ? { document_ids: ids, grouping_basis: 'event_time' }
      : null;
  }

  if (left.event_time || right.event_time) {
    const timed = left.event_time ?? right.event_time!;
    const untimed = left.event_time ? right : left;
    return calendarDateAt(timed, untimed.timezone) === effectiveDate(untimed)
      ? { document_ids: ids, grouping_basis: 'event_time' }
      : null;
  }

  const dayDifference = Math.abs(utcDayStart(effectiveDate(left)) - utcDayStart(effectiveDate(right))) / DAY_MS;
  return dayDifference <= 1
    ? { document_ids: ids, grouping_basis: 'capture_date_degraded' }
    : null;
}

/** 一次 person 级作业检查全部未归组文档，不按日历日拆任务。 */
export function encounterCandidatePairs(items: EncounterCandidateDocumentT[]): EncounterCandidatePairT[] {
  const pairs: EncounterCandidatePairT[] = [];
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const pair = eligibleEncounterPair(items[left]!, items[right]!);
      if (pair) pairs.push(pair);
    }
  }
  return pairs;
}

export function proposalsFromEncounterJudgments(
  personId: string,
  documents: EncounterCandidateDocumentT[],
  pairs: EncounterCandidatePairT[],
  output: EncounterSuggestionModelOutT,
): EncounterProposalT[] {
  const byId = new Map(documents.map((item) => [item.id, item]));
  const eligible = new Map(pairs.map((pair) => [pairKey(pair.document_ids), pair]));
  const seen = new Set<string>();
  const proposals: EncounterProposalT[] = [];

  for (const judgment of output.judgments) {
    const key = pairKey(judgment.document_ids);
    if (seen.has(key)) throw new Error(`模型重复判断候选对: ${key}`);
    seen.add(key);
    const pair = eligible.get(key);
    if (!pair) throw new Error(`模型引用了预筛之外的文档对: ${key}`);
    if (!judgment.same_encounter) continue;
    const docs = pair.document_ids.map((id) => byId.get(id));
    if (docs.some((item) => !item)) throw new Error(`候选文档不存在: ${key}`);
    const [first, second] = docs as [EncounterCandidateDocumentT, EncounterCandidateDocumentT];
    const dates = [effectiveDate(first), effectiveDate(second)].sort();
    const eventTimes = [first.event_time, second.event_time]
      .filter((value): value is string => value !== null)
      .sort();
    const departments = [first.department_raw, second.department_raw].filter((value): value is string => value !== null);
    proposals.push({
      encounter_id: uuidv7(),
      person_id: personId,
      document_ids: pair.document_ids,
      document_short_ids: [first.short_id, second.short_id],
      facility_id: first.facility_id,
      grouping_basis: pair.grouping_basis,
      encounter_type: judgment.encounter_type,
      occurred_on: dates[0]!,
      occurred_at: eventTimes[0] ?? null,
      department: departments.length === 2 && departments[0] === departments[1] ? departments[0]! : null,
      confidence: judgment.confidence,
      reason: judgment.reason,
    });
  }
  if (seen.size !== eligible.size) throw new Error('模型没有逐条返回全部预筛候选对');
  return proposals;
}
