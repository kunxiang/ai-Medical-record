import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  orderedUniqueHumanReplay, parseDecisionObject, parseJournalObject,
} from '../src/human-replay.js';

const ACCOUNT_ID = '01890f00-0000-7000-8000-000000000001';
const ARCHIVE_ID = '01890f00-0000-7000-8000-000000000002';
const ACK_ID = '01890f00-0000-7000-8000-000000000003';
const DECISION_ID = '01890f00-0000-7000-8000-000000000004';
const SESSION_ID = '01890f00-0000-7000-8000-000000000005';
const ANSWER_ID = '01890f00-0000-7000-8000-000000000006';
const UPLOAD_ID = '01890f00-0000-7000-8000-000000000007';
const OBSERVATION_ID = '01890f00-0000-7000-8000-000000000008';
const ALIAS_ID = '01890f00-0000-7000-8000-000000000009';
const METRIC_GROUP_ID = '01890f00-0000-7000-8000-000000000010';
const METRIC_ITEM_ID = '01890f00-0000-7000-8000-000000000011';
const MEDICATION_ID = '01890f00-0000-7000-8000-000000000012';
const TIMELINE_EVENT_ID = '01890f00-0000-7000-8000-000000000013';

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

function metadataUpsert(at: string) {
  return {
    schema_version: '1.0', event: 'document_metadata_upsert', event_id: ARCHIVE_ID,
    at, by_account_id: ACCOUNT_ID, client_operation_id: ARCHIVE_ID,
    person_slug: 'p23456', subject_id: DECISION_ID, revision: 1,
    before: null,
    after: {
      document_id: DECISION_ID, doc_type: 'lab_report', sampled_on: '2026-08-27',
      reported_on: null, facility_id: null, facility_name_raw: '测试医院',
      department: '检验科', title: '血脂', note: null,
      field_provenance: {
        title: { source: 'manual', event_id: ARCHIVE_ID, suggestion_id: null },
      },
      revision: 1, updated_by: ACCOUNT_ID, updated_at: at,
    },
    operation_replay: {
      request_hash: 'b'.repeat(64), response_snapshot: { document_id: DECISION_ID, revision: 1 },
    },
    references: { facility: null, suggestion: null },
  };
}

const contextQuestion = {
  key: 'visit_reason', text: '为什么来医院？', answer_type: 'text', options: [],
  skippable: true, allow_text_fallback: false, max_duration_ms: null,
  number_min: null, number_max: null, maps_to: null,
  timeline_kind: 'visit_reason', event_time_source: 'session_started_at',
};

function contextSession(at: string) {
  const session = {
    id: SESSION_ID, person_id: DECISION_ID, scope_type: 'standalone', scope_key: SESSION_ID,
    client_document_id: null, document_id: null, encounter_id: null,
    template_id: 'generic', template_version: 1, template_hash: 'c'.repeat(64),
    question_snapshot: [contextQuestion], stage: 'anytime', status: 'active', revision: 1,
    created_by: ACCOUNT_ID, created_at: at, updated_by: ACCOUNT_ID, updated_at: at,
    completed_at: null,
  };
  return {
    schema_version: '1.0', event: 'context_session_upsert', event_id: SESSION_ID,
    at, by_account_id: ACCOUNT_ID, client_operation_id: SESSION_ID,
    person_slug: 'p23456', subject_id: SESSION_ID, revision: 1,
    before: null, after: session,
    operation_replay: { request_hash: 'd'.repeat(64), response_snapshot: { session, answers: [] } },
    references: {},
  };
}

function contextAnswer(at: string) {
  const session = { ...contextSession(at).after, revision: 2, updated_at: at };
  const answer = {
    id: ANSWER_ID, session_id: SESSION_ID, question_key: 'visit_reason',
    question_text: '为什么来医院？', question_snapshot: contextQuestion,
    answer_type: 'text', value: '复查', upload_id: null, skipped: false,
    answered_at: at, event_on: '2026-08-27', event_at: at, time_precision: 'minute',
    event_time_source: 'session_started_at', revision: 1, updated_by: ACCOUNT_ID, updated_at: at,
  };
  return {
    schema_version: '1.0', event: 'context_answer_upsert', event_id: ANSWER_ID,
    at, by_account_id: ACCOUNT_ID, client_operation_id: ANSWER_ID,
    person_slug: 'p23456', subject_id: SESSION_ID, revision: 2,
    before: [], after: [answer], session_after: session,
    operation_replay: {
      request_hash: 'e'.repeat(64), response_snapshot: { session, answers: [answer] },
    },
    references: {},
  };
}

function contextMedia(at: string) {
  const upload = {
    id: UPLOAD_ID, person_id: DECISION_ID, session_id: SESSION_ID,
    question_key: 'visit_reason', kind: 'audio', mime: 'audio/mp4', byte_size: 1024,
    sha256: 'f'.repeat(64), state: 'finalized', created_at: at, finalized_at: at,
    object_key: `people/p23456/context/${SESSION_ID}/visit_reason__${UPLOAD_ID}.m4a`,
    multipart_state: null, created_by: ACCOUNT_ID,
  };
  return {
    schema_version: '1.0', event: 'context_media_finalize', event_id: UPLOAD_ID,
    at, by_account_id: ACCOUNT_ID, client_operation_id: UPLOAD_ID,
    person_slug: 'p23456', subject_id: UPLOAD_ID, revision: 1,
    before: null, after: upload,
    operation_replay: { request_hash: 'f'.repeat(64), response_snapshot: { upload } },
    references: {},
  };
}

function observationFact(at: string) {
  return {
    id: OBSERVATION_ID, person_id: DECISION_ID, document_id: null, encounter_id: null,
    client_row_id: OBSERVATION_ID, observed_on: '2026-08-27', observed_at: null,
    time_precision: 'date', date_source: 'manual', local_name: '葡萄糖',
    concept_code: 'GLUCOSE', concept_catalog_version: '2026.08', loinc_code: null,
    qualifier: null, body_site: null, extra_dims: null, series_key: '1'.repeat(64),
    value_raw: '5.6', value_num: 5.6, comparator: null, value_text: null,
    value_dimensions: null, unit_raw: 'mmol/L', unit_ucum: 'mmol/L',
    value_si: 5.6, unit_si: 'mmol/L', conversion_version: 'medical-units@1',
    ref_low: 3.9, ref_high: 6.1, ref_text: null, ref_unit: 'mmol/L',
    abnormal_flag_raw: 'N', abnormal_flag: 'normal', specimen: 'serum',
    specimen_label: '血清', method: null, device: null, measurement_setting: null,
    result_kind: 'measured', collected_at: null, reported_at: null, lab_facility_id: null,
    mapping_status: 'mapped', source_page: null, source: 'manual', source_ref: null,
    review_status: 'confirmed', reviewed_by: ACCOUNT_ID, reviewed_at: at,
    consistency_flags: [], is_derived: false, derived_formula: null,
    calculation_version: null, derivation_key: null, input_observation_ids: null,
    input_revision_hash: null, revision: 1, created_by: ACCOUNT_ID, created_at: at,
    updated_by: ACCOUNT_ID, updated_at: at, archived_at: null,
  };
}

const glucoseConcept = {
  code: 'GLUCOSE', display_name: '葡萄糖', aliases: ['血糖'], kind: 'laboratory',
  loinc_code: null, canonical_unit: 'mmol/L', catalog_version: '2026.08',
};

function observationUpsert(at: string) {
  return {
    schema_version: '1.0', event: 'observation_upsert', event_id: OBSERVATION_ID,
    at, by_account_id: ACCOUNT_ID, client_operation_id: OBSERVATION_ID,
    person_slug: 'p23456', subject_id: OBSERVATION_ID, revision: 1,
    before: [], after: [observationFact(at)], correction_note: null,
    operation_replay: { request_hash: '2'.repeat(64), response_snapshot: { ok: true } },
    references: { concepts: [glucoseConcept], facilities: [], suggestion: null },
  };
}

function conceptAliasUpsert(at: string) {
  const alias = {
    id: ALIAS_ID, person_id: DECISION_ID, input_fingerprint: '3'.repeat(64),
    local_name: '本院血糖', context: { specimen: 'serum', method: null },
    concept_code: 'GLUCOSE', display_name: '葡萄糖', catalog_version: '2026.08',
    state: 'confirmed', revision: 1, decided_by: ACCOUNT_ID, decided_at: at, updated_at: at,
  };
  return {
    schema_version: '1.0', event: 'concept_alias_upsert', event_id: ALIAS_ID,
    at, by_account_id: ACCOUNT_ID, client_operation_id: ALIAS_ID,
    person_slug: 'p23456', subject_id: ALIAS_ID, revision: 1,
    before: null, after: alias, observations_before: [observationFact(at)],
    observations_after: [observationFact(at)],
    operation_replay: { request_hash: '4'.repeat(64), response_snapshot: { ok: true } },
    references: { concept: glucoseConcept },
  };
}

function metricGroupUpsert(at: string) {
  const group = {
    id: METRIC_GROUP_ID, person_id: DECISION_ID, name: '血糖监控', description: null,
    preset_origin: null,
    items: [{
      id: METRIC_ITEM_ID, position: 0, item_type: 'series',
      selector: {
        concept_code: 'GLUCOSE', qualifier: null, body_site: null, specimen: 'serum',
        method: null, device: null, measurement_setting: null, extra_dims: null,
        result_kind: 'measured',
      },
      series_selector_hash: '5'.repeat(64),
    }],
    revision: 1, created_by: ACCOUNT_ID, created_at: at,
    updated_by: ACCOUNT_ID, updated_at: at, archived_at: null,
  };
  return {
    schema_version: '1.0', event: 'metric_group_upsert', event_id: METRIC_GROUP_ID,
    at, by_account_id: ACCOUNT_ID, client_operation_id: METRIC_GROUP_ID,
    person_slug: 'p23456', subject_id: METRIC_GROUP_ID, revision: 1,
    before: null, after: group,
    operation_replay: { request_hash: '6'.repeat(64), response_snapshot: group },
    references: {},
  };
}

function medicationUpsert(at: string) {
  const medication = {
    id: MEDICATION_ID, person_id: DECISION_ID, client_row_id: MEDICATION_ID,
    encounter_id: null, kind: 'administered', name_raw: '0.9% 氯化钠', generic_name: null,
    dose_raw: '500 mL', dose_value: 500, dose_unit: 'mL', concentration_pct: 0.9,
    solute_mass_g: 4.5, frequency_raw: null, route: '静脉滴注', administration_group: '组 1',
    group_volume_ml: 500, sequence: 1, administered_at: at, started_on: null, ended_on: null,
    source_page: null, note: null, canonical_on: at.slice(0, 10), canonical_at: at,
    time_precision: 'minute', source: 'manual', source_ref: null, revision: 1,
    created_by: ACCOUNT_ID, created_at: at, updated_by: ACCOUNT_ID, updated_at: at,
    archived_at: null,
  };
  return {
    schema_version: '1.0', event: 'medication_upsert', event_id: MEDICATION_ID,
    at, by_account_id: ACCOUNT_ID, client_operation_id: MEDICATION_ID,
    person_slug: 'p23456', subject_id: MEDICATION_ID, revision: 1,
    before: [], after: [medication], correction_note: null,
    operation_replay: { request_hash: '7'.repeat(64), response_snapshot: { medications: [medication], warnings: [] } },
    references: {},
  };
}

function timelineEventUpsert(at: string) {
  const event = {
    id: TIMELINE_EVENT_ID, person_id: DECISION_ID, encounter_id: null, kind: 'other',
    title: '日期待确认', occurred_on: null, occurred_at: null, time_precision: 'unknown',
    note: null, source_page: null, source: 'manual', source_ref: null, revision: 1,
    created_by: ACCOUNT_ID, created_at: at, updated_by: ACCOUNT_ID, updated_at: at,
    archived_at: null,
  };
  return {
    schema_version: '1.0', event: 'timeline_event_upsert', event_id: TIMELINE_EVENT_ID,
    at, by_account_id: ACCOUNT_ID, client_operation_id: TIMELINE_EVENT_ID,
    person_slug: 'p23456', subject_id: TIMELINE_EVENT_ID, revision: 1,
    before: null, after: event, correction_note: null,
    operation_replay: { request_hash: '8'.repeat(64), response_snapshot: event }, references: {},
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

  it('parses P0 full-snapshot fact events for deterministic replay', () => {
    const parsed = parseJournalObject(
      'people/p23456/journal/2026-08.jsonl',
      JSON.stringify(metadataUpsert('2026-08-27T10:00:00.000Z')),
    );
    expect(parsed.reconciliation).toEqual([]);
    expect(parsed.items[0]?.replayKind).toBe('document_metadata_upsert');
    if (parsed.items[0]?.replayKind === 'document_metadata_upsert') {
      expect(parsed.items[0].line.operation_replay.request_hash).toBe('b'.repeat(64));
      expect(parsed.items[0].line.after.field_provenance.title?.source).toBe('manual');
    }
  });

  it('parses P1 session/answer/media events as first-class replay items', () => {
    const parsed = parseJournalObject('people/p23456/journal/2026-08.jsonl', [
      JSON.stringify(contextSession('2026-08-27T10:00:00.000Z')),
      JSON.stringify(contextMedia('2026-08-27T10:01:00.000Z')),
      JSON.stringify(contextAnswer('2026-08-27T10:02:00.000Z')),
    ].join('\n'));
    expect(parsed.reconciliation).toEqual([]);
    expect(parsed.items.map((item) => item.replayKind)).toEqual([
      'context_session_upsert', 'context_media_finalize', 'context_answer_upsert',
    ]);
  });

  it('parses P2 observation and concept-alias snapshots as first-class replay items', () => {
    const parsed = parseJournalObject('people/p23456/journal/2026-08.jsonl', [
      JSON.stringify(observationUpsert('2026-08-27T11:00:00.000Z')),
      JSON.stringify(conceptAliasUpsert('2026-08-27T11:01:00.000Z')),
    ].join('\n'));
    expect(parsed.reconciliation).toEqual([]);
    expect(parsed.items.map((item) => item.replayKind)).toEqual([
      'observation_upsert', 'concept_alias_upsert',
    ]);
  });

  it('parses P3 metric group snapshots as first-class replay items', () => {
    const parsed = parseJournalObject(
      'people/p23456/journal/2026-08.jsonl',
      JSON.stringify(metricGroupUpsert('2026-08-27T12:00:00.000Z')),
    );
    expect(parsed.reconciliation).toEqual([]);
    expect(parsed.items[0]?.replayKind).toBe('metric_group_upsert');
  });

  it('parses P4 medication and undated timeline facts as first-class replay items', () => {
    const parsed = parseJournalObject('people/p23456/journal/2026-08.jsonl', [
      JSON.stringify(medicationUpsert('2026-08-27T12:30:00.000Z')),
      JSON.stringify(timelineEventUpsert('2026-08-27T12:31:00.000Z')),
    ].join('\n'));
    expect(parsed.reconciliation).toEqual([]);
    expect(parsed.items.map((item) => item.replayKind)).toEqual([
      'medication_upsert', 'timeline_event_upsert',
    ]);
  });
});

describe('M2 rebuild static boundaries', () => {
  it('includes every explicitly marked M2 L1 column in verify-rebuild', () => {
    const source = readFileSync(new URL('../src/verify-rebuild.ts', import.meta.url), 'utf8');
    expect(source).toContain('archived_at');
    expect(source).toContain('person_check_ack_at');
    expect(source).toContain('grouping_basis');
    expect(source).toContain('contextSessions');
    expect(source).toContain('contextAnswers');
    expect(source).toContain('contextUploads');
    expect(source).toContain('conceptAliases');
    expect(source).toContain('observations');
    expect(source).toContain('derivedObservations');
    expect(source).toContain('metricGroups');
    expect(source).toContain('metricGroupItems');
    expect(source).toContain('medications');
    expect(source).toContain('timelineEvents');
    expect(source).toContain('origin_capture_document_id');
    expect(source).toContain('origin_capture_order');
    expect(source).toContain('origin_object_sha256');
  });

  it('does not make rebuild depend on Stage 1 extraction artifacts', () => {
    const source = readFileSync(new URL('../src/rebuild-index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/extractions|Stage1Out/);
  });
});
