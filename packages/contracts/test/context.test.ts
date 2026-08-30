import { describe, expect, it } from 'vitest';
import {
  ContextAnswerInput,
  ContextAnswersUpsertRequest,
  ContextQuestion,
  ContextSessionCreate,
  ContextUploadFinalizeRequest,
  ContextUploadPrepareRequest,
  ContextUploadPresignResponse,
} from '../src/index.js';

const id = '018f0000-0000-7000-8000-000000000001';
const hash = 'a'.repeat(64);
const question = {
  key: 'visit_reason', text: '今天为什么来医院？', answer_type: 'text' as const,
  options: [], skippable: true, allow_text_fallback: false, max_duration_ms: null,
  number_min: null, number_max: null, maps_to: null, timeline_kind: 'visit_reason' as const,
  event_time_source: 'session_started_at' as const,
};

describe('P1 context contracts', () => {
  it('只允许 date/datetime timeline 题从 answer_value 取事件时间', () => {
    expect(() => ContextQuestion.parse({ ...question, event_time_source: 'answer_value' })).toThrow();
    expect(ContextQuestion.parse({
      ...question, key: 'followup_on', answer_type: 'date', event_time_source: 'answer_value',
    }).event_time_source).toBe('answer_value');
  });

  it('document 与 standalone scope 不得伪造彼此的文档身份', () => {
    const base = {
      client_operation_id: id, id, person_id: id,
      scope_key: 'capture-document-1', client_document_id: 'capture-document-1',
      document_id: null, encounter_id: null,
      template_id: 'lab-report', template_version: 1, template_hash: hash,
      question_snapshot: [question], stage: 'onsite' as const,
    };
    expect(ContextSessionCreate.parse({ ...base, scope_type: 'document' }).scope_key)
      .toBe('capture-document-1');
    expect(() => ContextSessionCreate.parse({
      ...base, scope_type: 'document', scope_key: 'different-document',
    })).toThrow();
    expect(() => ContextSessionCreate.parse({
      ...base, scope_type: 'document', document_id: id,
    })).toThrow();
    expect(() => ContextSessionCreate.parse({ ...base, scope_type: 'standalone' })).toThrow();
    expect(ContextSessionCreate.parse({
      ...base, scope_type: 'standalone', scope_key: id, client_document_id: null,
    }).client_document_id).toBeNull();
  });

  it('回答值严格区分跳过、普通值和 finalized upload reference', () => {
    expect(ContextAnswerInput.parse({
      question_key: 'visit_reason', answer_type: 'text', value: '复查', skipped: false,
      answered_at: null,
    }).value).toBe('复查');
    expect(ContextAnswerInput.parse({
      question_key: 'visit_reason', answer_type: 'text', value: null, skipped: true,
      answered_at: null,
    }).skipped).toBe(true);
    expect(ContextAnswerInput.parse({
      question_key: 'voice_note', answer_type: 'audio', value: { upload_id: id }, skipped: false,
      answered_at: null,
    }).value).toEqual({ upload_id: id });
    expect(() => ContextAnswerInput.parse({
      question_key: 'voice_note', answer_type: 'audio', value: { object_key: 'people/x/audio.m4a' },
      skipped: false, answered_at: null,
    })).toThrow();
  });

  it('回答 batch 最多 30 题并拒绝重复 question_key', () => {
    const answer = {
      question_key: 'visit_reason', answer_type: 'text' as const, value: '复查', skipped: false as const,
      answered_at: null,
    };
    expect(() => ContextAnswersUpsertRequest.parse({
      client_operation_id: id, if_revision: 1, answers: [answer, answer],
    })).toThrow();
    expect(() => ContextAnswersUpsertRequest.parse({
      client_operation_id: id, if_revision: 1,
      answers: Array.from({ length: 31 }, (_, index) => ({ ...answer, question_key: `question_${index}` })),
    })).toThrow();
  });

  it('媒体 prepare 绑定 kind/MIME/bytes/SHA，音频上限独立', () => {
    const base = {
      client_operation_id: id, person_id: id, session_id: id, question_key: 'voice_note', sha256: hash,
    };
    expect(ContextUploadPrepareRequest.parse({
      ...base, kind: 'audio', mime: 'audio/mp4', byte_size: 1024,
    }).kind).toBe('audio');
    expect(() => ContextUploadPrepareRequest.parse({
      ...base, kind: 'audio', mime: 'image/jpeg', byte_size: 1024,
    })).toThrow();
    expect(() => ContextUploadPrepareRequest.parse({
      ...base, kind: 'audio', mime: 'audio/mp4', byte_size: 26 * 1024 * 1024,
    })).toThrow();
  });

  it('媒体 presign 区分 single/multipart，finalize parts 有稳定默认值', () => {
    const upload = {
      id, person_id: id, session_id: id, question_key: 'voice_note', kind: 'audio' as const,
      mime: 'audio/mp4' as const, byte_size: 1024, sha256: hash, state: 'uploading' as const,
      created_at: '2026-08-28T00:00:00.000Z', finalized_at: null,
    };
    expect(ContextUploadPresignResponse.parse({
      upload, mode: 'single', method: 'PUT', url: 'https://s3.example/upload', headers: {},
      expires_at: '2026-08-28T00:15:00.000Z', part_size: null, part_count: null, parts: [],
    }).mode).toBe('single');
    expect(ContextUploadPresignResponse.parse({
      upload, mode: 'multipart', method: 'PUT', url: null, headers: {},
      expires_at: '2026-08-28T00:15:00.000Z', part_size: 8 * 1024 * 1024, part_count: 2,
      parts: [
        { part_number: 1, url: 'https://s3.example/part-1' },
        { part_number: 2, url: 'https://s3.example/part-2' },
      ],
    }).mode).toBe('multipart');
    expect(ContextUploadFinalizeRequest.parse({ client_operation_id: id }).parts).toEqual([]);
  });
});
