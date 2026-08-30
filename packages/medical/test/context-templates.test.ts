import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJsonString, ContextTemplateDefinition } from '@amr/contracts';
import {
  CONTEXT_TEMPLATE_DEFINITIONS,
  CONTEXT_TEMPLATE_HASHES,
  contextTemplateManifest,
  getContextTemplate,
  resolveContextQuestions,
} from '../src/index.js';

describe('P1 versioned context templates', () => {
  it('每个模板都是 strict contract，且 id/version 唯一', () => {
    const keys = CONTEXT_TEMPLATE_DEFINITIONS.map((definition) => {
      expect(ContextTemplateDefinition.parse(definition)).toEqual(definition);
      return `${definition.template_id}@${definition.version}`;
    });
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining([
      'lab-report@1', 'imaging-report@1', 'prescription@1', 'checkup-report@1', 'generic@1',
    ]));
  });

  it('模板 hash 覆盖 canonical definition 并与 manifest 一致', () => {
    for (const definition of CONTEXT_TEMPLATE_DEFINITIONS) {
      const key = `${definition.template_id}@${definition.version}` as keyof typeof CONTEXT_TEMPLATE_HASHES;
      const actual = createHash('sha256').update(canonicalJsonString(definition)).digest('hex');
      expect(CONTEXT_TEMPLATE_HASHES[key]).toBe(actual);
      expect(getContextTemplate(definition.template_id, definition.version)?.template_hash).toBe(actual);
    }
    expect(contextTemplateManifest().templates).toHaveLength(5);
  });

  it('女性年龄条件只确定性追加月经周期题', () => {
    const lab = CONTEXT_TEMPLATE_DEFINITIONS.find((item) => item.template_id === 'lab-report')!;
    expect(resolveContextQuestions(lab, 'onsite', { sex_at_birth: 'female', age: 35 })
      .map((question) => question.key)).toContain('menstrual_phase');
    expect(resolveContextQuestions(lab, 'onsite', { sex_at_birth: 'male', age: 35 })
      .map((question) => question.key)).not.toContain('menstrual_phase');
    expect(resolveContextQuestions(lab, 'onsite', { sex_at_birth: 'female', age: 70 })
      .map((question) => question.key)).not.toContain('menstrual_phase');
  });

  it('录音题保留文字替代，所有题可跳过', () => {
    for (const definition of CONTEXT_TEMPLATE_DEFINITIONS) {
      const questions = [
        ...Object.values(definition.stages).flatMap((stage) => stage?.questions ?? []),
        ...definition.conditional.flatMap((condition) => condition.questions),
      ];
      expect(questions.every((question) => question.skippable)).toBe(true);
      expect(questions.filter((question) => question.answer_type === 'audio')
        .every((question) => question.allow_text_fallback)).toBe(true);
    }
  });
});
