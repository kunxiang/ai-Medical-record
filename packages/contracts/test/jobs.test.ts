import { describe, expect, it } from 'vitest';
import { AiJobError } from '../src/jobs.js';

describe('AiJobError', () => {
  it('历史非 refusal 错误缺少 category 时规范化为 null', () => {
    const parsed = AiJobError.parse({
      stage: 'worker',
      code: 'unhandled',
      message: '模型凭证未配置',
      at: '2026-08-26T10:30:41.188Z',
    });
    expect(parsed.category).toBeNull();
  });

  it('保留 refusal 的已知 category', () => {
    const parsed = AiJobError.parse({
      stage: 's1',
      code: 'refusal',
      message: '模型拒绝',
      category: 'medical',
      at: '2026-08-26T10:30:41.188Z',
    });
    expect(parsed.category).toBe('medical');
  });
});
