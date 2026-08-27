import { afterEach, describe, expect, it } from 'vitest';
import { setTransport } from '../src/transport.js';
import { buildEncounterRequest, callEncounterSuggestion, EncounterSuggestionError } from '../src/encounter.js';

const documents = [{
  id: '00000000-0000-4000-8000-000000000001', short_id: 'd23456',
  facility_id: '00000000-0000-4000-8000-000000000002', doc_type: 'lab_report',
  event_time: null, sampled_on: '2026-08-20', reported_on: null, capture_date: '2026-08-20', department_raw: '检验科', timezone: 'Asia/Shanghai',
}, {
  id: '00000000-0000-4000-8000-000000000003', short_id: 'd23457',
  facility_id: '00000000-0000-4000-8000-000000000002', doc_type: 'visit_note',
  event_time: null, sampled_on: '2026-08-21', reported_on: null, capture_date: '2026-08-21', department_raw: '检验科', timezone: 'Asia/Shanghai',
}];
const pairs = [{
  document_ids: [documents[0]!.id, documents[1]!.id] as [string, string],
  grouping_basis: 'capture_date_degraded' as const,
}];

afterEach(() => setTransport(null));

describe('encounter suggestion client', () => {
  it('动态候选只进入 user message', () => {
    const request = buildEncounterRequest(documents, pairs);
    expect(JSON.stringify(request.system)).not.toContain(documents[0]!.id);
    expect(JSON.stringify(request.messages)).toContain(documents[0]!.id);
  });

  it('校验并返回结构化判断', async () => {
    setTransport(async () => ({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'test-model', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify({ judgments: [{
        document_ids: pairs[0]!.document_ids, same_encounter: true, encounter_type: 'outpatient', confidence: 0.85, reason: '同科室连续记录',
      }] }) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as never));
    const result = await callEncounterSuggestion(documents, pairs);
    expect(result.output.judgments[0]?.same_encounter).toBe(true);
    expect(result.promptVersion).toBe(1);
  });

  it('refusal 进入终态错误', async () => {
    setTransport(async () => ({ stop_reason: 'refusal', content: [], usage: {}, model: 'test' } as never));
    await expect(callEncounterSuggestion(documents, pairs)).rejects.toMatchObject<Partial<EncounterSuggestionError>>({ kind: 'refusal' });
  });
});
