import {
  type ContextAnswerInputT, type ContextQuestionT,
} from '@amr/contracts';
import { captureDateInZone } from '@amr/storage';
import { ApiError } from '../errors.js';

export function validateAnswerAgainstQuestion(
  answer: ContextAnswerInputT,
  question: ContextQuestionT,
): void {
  if (answer.skipped) {
    if (!question.skippable) throw new ApiError('validation_failed', `${question.key} 不允许跳过`);
    return;
  }
  const fallback = question.answer_type === 'audio' && question.allow_text_fallback && answer.answer_type === 'text';
  if (answer.answer_type !== question.answer_type && !fallback) {
    throw new ApiError('validation_failed', `${question.key} 的答案类型不匹配`);
  }
  if (answer.answer_type === 'choice'
      && (typeof answer.value !== 'string' || !question.options.some((option) => option.value === answer.value))) {
    throw new ApiError('validation_failed', `${question.key} 包含未知选项`);
  }
  if (answer.answer_type === 'multi_choice') {
    const allowed = new Set(question.options.map((option) => option.value));
    if (!Array.isArray(answer.value) || answer.value.some((value: string) => !allowed.has(value))) {
      throw new ApiError('validation_failed', `${question.key} 包含未知选项`);
    }
  }
  if (answer.answer_type === 'number') {
    if (typeof answer.value !== 'number') throw new ApiError('validation_failed', `${question.key} 需要数字答案`);
    if (question.number_min !== null && answer.value < question.number_min) {
      throw new ApiError('validation_failed', `${question.key} 小于允许下限`);
    }
    if (question.number_max !== null && answer.value > question.number_max) {
      throw new ApiError('validation_failed', `${question.key} 大于允许上限`);
    }
  }
}

export function deriveContextEventTime(input: {
  answer: ContextAnswerInputT; question: ContextQuestionT; timezone: string;
  sessionCreatedAt: Date; documentSampledOn: string | null;
}): {
  eventOn: string | null; eventAt: Date | null; precision: 'date' | 'minute' | 'unknown' | null;
  source: ContextQuestionT['event_time_source'] | null;
} {
  if (input.question.timeline_kind === null) {
    return { eventOn: null, eventAt: null, precision: null, source: null };
  }
  const source = input.question.event_time_source;
  if (source === 'answer_value' && !input.answer.skipped) {
    if (input.answer.answer_type === 'date' && typeof input.answer.value === 'string') {
      return { eventOn: input.answer.value, eventAt: null, precision: 'date', source };
    }
    if (input.answer.answer_type === 'datetime' && typeof input.answer.value === 'string') {
      return {
        eventOn: captureDateInZone(input.answer.value, input.timezone),
        eventAt: new Date(input.answer.value), precision: 'minute', source,
      };
    }
  }
  if (source === 'document_sampled_on') {
    return {
      eventOn: input.documentSampledOn, eventAt: null,
      precision: input.documentSampledOn ? 'date' : 'unknown', source,
    };
  }
  if (source === 'session_started_at') {
    return {
      eventOn: captureDateInZone(input.sessionCreatedAt.toISOString(), input.timezone),
      eventAt: input.sessionCreatedAt, precision: 'minute', source,
    };
  }
  return { eventOn: null, eventAt: null, precision: 'unknown', source };
}
