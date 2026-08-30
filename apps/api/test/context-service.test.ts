import { describe, expect, it } from 'vitest';
import { ContextAnswerInput, ContextQuestion } from '@amr/contracts';
import { ApiError } from '../src/errors.js';
import {
  deriveContextEventTime, validateAnswerAgainstQuestion,
} from '../src/services/context-validation.js';

describe('P1 context deterministic validation', () => {
  it('选择题、数值范围和 audio 文字替代由冻结问题约束', () => {
    const choice = ContextQuestion.parse({
      key: 'fasting_status', text: '是否空腹？', answer_type: 'choice',
      options: [{ value: 'yes', label: '是' }, { value: 'no', label: '否' }],
    });
    expect(() => validateAnswerAgainstQuestion(ContextAnswerInput.parse({
      question_key: 'fasting_status', answer_type: 'choice', value: 'yes', skipped: false,
    }), choice)).not.toThrow();
    expect(() => validateAnswerAgainstQuestion(ContextAnswerInput.parse({
      question_key: 'fasting_status', answer_type: 'choice', value: 'maybe', skipped: false,
    }), choice)).toThrow(ApiError);

    const number = ContextQuestion.parse({
      key: 'temperature', text: '体温', answer_type: 'number', number_min: 30, number_max: 45,
    });
    expect(() => validateAnswerAgainstQuestion(ContextAnswerInput.parse({
      question_key: 'temperature', answer_type: 'number', value: 50, skipped: false,
    }), number)).toThrow(ApiError);

    const audio = ContextQuestion.parse({
      key: 'doctor_advice', text: '医生说了什么？', answer_type: 'audio', allow_text_fallback: true,
    });
    expect(() => validateAnswerAgainstQuestion(ContextAnswerInput.parse({
      question_key: 'doctor_advice', answer_type: 'text', value: '一周后复查', skipped: false,
    }), audio)).not.toThrow();
  });

  it('timeline 时间来源不制造午夜精度且按账户时区取日期', () => {
    const answer = ContextAnswerInput.parse({
      question_key: 'followup_at', answer_type: 'datetime',
      value: '2026-08-28T16:30:00.000Z', skipped: false,
    });
    const question = ContextQuestion.parse({
      key: 'followup_at', text: '何时复查？', answer_type: 'datetime',
      timeline_kind: 'followup_plan', event_time_source: 'answer_value',
    });
    const event = deriveContextEventTime({
      answer, question, timezone: 'Asia/Shanghai',
      sessionCreatedAt: new Date('2026-08-28T10:00:00.000Z'), documentSampledOn: null,
    });
    expect(event.eventOn).toBe('2026-08-29');
    expect(event.eventAt?.toISOString()).toBe('2026-08-28T16:30:00.000Z');
    expect(event.precision).toBe('minute');

    const sampledQuestion = ContextQuestion.parse({
      key: 'symptom', text: '当时症状', answer_type: 'text',
      timeline_kind: 'symptom', event_time_source: 'document_sampled_on',
    });
    expect(deriveContextEventTime({
      answer: ContextAnswerInput.parse({
        question_key: 'symptom', answer_type: 'text', value: '头痛', skipped: false,
      }),
      question: sampledQuestion, timezone: 'Asia/Shanghai',
      sessionCreatedAt: new Date('2026-08-28T10:00:00.000Z'), documentSampledOn: null,
    })).toMatchObject({ eventOn: null, eventAt: null, precision: 'unknown' });
  });
});
