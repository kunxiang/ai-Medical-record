import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  orderedUniqueHumanReplay, parseDecisionObject, parseJournalObject,
} from '../src/human-replay.js';

const ACCOUNT_ID = '01890f00-0000-7000-8000-000000000001';
const ARCHIVE_ID = '01890f00-0000-7000-8000-000000000002';
const ACK_ID = '01890f00-0000-7000-8000-000000000003';
const DECISION_ID = '01890f00-0000-7000-8000-000000000004';

function archive(at: string, eventId = ARCHIVE_ID) {
  return {
    schema_version: '1.0', event: 'document_archive', event_id: eventId, at,
    by_account_id: ACCOUNT_ID, client_operation_id: eventId,
    document_short_id: 'd23456', archived: true, reason: '重复拍摄',
  };
}

function ack(at: string) {
  return {
    schema_version: '1.0', event: 'person_check_ack', event_id: ACK_ID, at,
    by_account_id: ACCOUNT_ID, client_operation_id: ACK_ID,
    document_short_id: 'd23456', from_check: 'mismatch', observed_name: '家长',
    expected_name: '孩子', reason: '报告使用监护人姓名',
  };
}

function facilityDecision(at: string) {
  return {
    schema_version: '1.0', op: 'normalization_confirm', event_id: DECISION_ID, at,
    by_account_id: ACCOUNT_ID, client_operation_id: DECISION_ID,
    kind: 'facility', input_fingerprint: 'a'.repeat(64), decision: 'confirmed',
    payload: {
      facility: { slug: 'f23456', name: '测试医院', city: '测试市', level: '三级' },
      matched_raw_names: ['测试医院', '市测试医院'], confidence: 0.99, reason: '同一机构',
    },
  };
}

describe('M2 human-layer replay input', () => {
  it('globally orders journal and decisions by (at,event_id) and deduplicates event_id', () => {
    const journal = parseJournalObject('people/p23456/journal/2026-08.jsonl', [
      JSON.stringify(ack('2026-08-27T09:00:00.000Z')),
      JSON.stringify(archive('2026-08-27T08:00:00.000Z')),
      JSON.stringify(archive('2026-08-27T10:00:00.000Z')),
    ].join('\n'));
    const decisions = parseDecisionObject(
      '_index/decisions/2026-08.jsonl',
      JSON.stringify(facilityDecision('2026-08-27T08:30:00.000Z')),
    );

    const seen = new Set<string>();
    const ordered = orderedUniqueHumanReplay([...journal.items, ...decisions.items], seen);

    expect(ordered.map((item) => item.replayKind)).toEqual([
      'document_archive', 'normalization_confirm', 'person_check_ack',
    ]);
    expect(seen).toEqual(new Set([ARCHIVE_ID, DECISION_ID, ACK_ID]));
  });

  it('shares idempotency with manifest event ids', () => {
    const parsed = parseJournalObject(
      'people/p23456/journal/2026-08.jsonl',
      JSON.stringify(archive('2026-08-27T08:00:00.000Z')),
    );
    expect(orderedUniqueHumanReplay(parsed.items, new Set([ARCHIVE_ID]))).toEqual([]);
  });

  it('reports malformed and forward-version events without blocking valid lines', () => {
    const parsed = parseJournalObject('people/p23456/journal/2026-08.jsonl', [
      '{bad json',
      JSON.stringify({ schema_version: '1.0', event: 'm3_future_event' }),
      JSON.stringify(ack('2026-08-27T09:00:00.000Z')),
    ].join('\n'));
    const decisions = parseDecisionObject('_index/decisions/2026-08.jsonl', [
      JSON.stringify({ schema_version: '1.0', op: 'm3_future_decision' }),
      JSON.stringify(facilityDecision('2026-08-27T09:30:00.000Z')),
    ].join('\n'));

    expect(parsed.items).toHaveLength(1);
    expect(decisions.items).toHaveLength(1);
    expect([...parsed.reconciliation, ...decisions.reconciliation]).toHaveLength(3);
  });
});

describe('M2 rebuild static boundaries', () => {
  it('includes every explicitly marked M2 L1 column in verify-rebuild', () => {
    const source = readFileSync(new URL('../src/verify-rebuild.ts', import.meta.url), 'utf8');
    expect(source).toContain('archived_at');
    expect(source).toContain('person_check_ack_at');
    expect(source).toContain('grouping_basis');
  });

  it('does not make rebuild depend on Stage 1 extraction artifacts', () => {
    const source = readFileSync(new URL('../src/rebuild-index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/extractions|Stage1Out/);
  });
});
