import { describe, expect, it } from 'vitest';
import { normalizeIdentity } from '../src/normalization.js';

describe('normalizeIdentity(m2-05 §1.3)', () => {
  it('按固定顺序做 NFKC、小写、空白和分隔符归一', () => {
    expect(normalizeIdentity(' ＡＢＣ·医 院 ')).toBe('abc医院');
    expect(normalizeIdentity('阿依古丽・买买提')).toBe('阿依古丽买买提');
    expect(normalizeIdentity('Smith_Jones/Clinic')).toBe('smithjonesclinic');
  });

  it('不做模糊或形近字符折叠', () => {
    expect(normalizeIdentity('张伟')).not.toBe(normalizeIdentity('张玮'));
  });
});
