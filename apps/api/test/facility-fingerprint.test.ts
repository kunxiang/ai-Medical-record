import { describe, expect, it } from 'vitest';
import { facilityFingerprint } from '../src/normalization/facility-fingerprint.js';

describe('facilityFingerprint(m2-05 §2.2)', () => {
  it('同一机构的大小写、空白、全半角与分隔符差异得到同一指纹', () => {
    const expected = facilityFingerprint('ＡＢＣ 医院');
    expect(facilityFingerprint('abc医院')).toBe(expected);
    expect(facilityFingerprint('ABC-医院')).toBe(expected);
  });

  it('不同机构得到不同指纹', () => {
    expect(facilityFingerprint('市第一医院')).not.toBe(facilityFingerprint('市第二医院'));
  });

  it('字节级可重现并输出 sha256 hex', () => {
    const first = facilityFingerprint('北京协和医院');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(facilityFingerprint('北京协和医院')).toBe(first);
  });
});
