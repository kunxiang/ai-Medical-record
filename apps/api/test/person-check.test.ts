// spec m2-05 §1.3。审核 #004 B-1 指出:"去除常见分隔符"是散文不是字母表 ——
// A10/A11 用的是"完全相同/完全不同"的用例,两种实现都能过,缺陷会带着上线。
// 因此把每条规则单独钉死。
import { describe, expect, it } from 'vitest';
import { normalizeName, personCheckOf } from '../src/person-check.js';

describe('normalizeName(m2-05 §1.3)', () => {
  it('折叠大小写', () => {
    expect(normalizeName('ZHANG WEI')).toBe(normalizeName('Zhang Wei'));
  });
  it('删空白(含全角空格)', () => {
    expect(normalizeName('张 伟')).toBe('张伟');
    expect(normalizeName('张　伟')).toBe('张伟');
  });
  it('删逐字列出的分隔符', () => {
    expect(normalizeName('阿依古丽·买买提')).toBe('阿依古丽买买提');
    expect(normalizeName('阿依古丽・买买提')).toBe('阿依古丽买买提');
    expect(normalizeName('Smith-Jones')).toBe('smithjones');
  });
  it('NFKC:全角与半角等价', () => {
    expect(normalizeName('ＺＨＡＮＧ')).toBe(normalizeName('ZHANG'));
  });
});

describe('personCheckOf(m2-05 §1)', () => {
  it('姓名一致 → match', () => {
    expect(personCheckOf('张伟', '张伟', null)).toBe('match');
    expect(personCheckOf('张 伟', '张伟', null)).toBe('match');
  });

  it('★ 形近但不同的名字 → mismatch,禁止任何相似度阈值', () => {
    // 「张伟」vs「张玮」相似度很高但是两个人。把这种判断交给一个数字,
    // 等于用不可解释的阈值决定病历归谁。
    expect(personCheckOf('张玮', '张伟', null)).toBe('mismatch');
    expect(personCheckOf('李明', '李明明', null)).toBe('mismatch');
  });

  it('patient_name 为 null → unknown(不是 mismatch)', () => {
    expect(personCheckOf(null, '张伟', null)).toBe('unknown');
  });

  it('pinyin 路径:display_name 不匹配但 name_pinyin 匹配 → match', () => {
    expect(personCheckOf('ZHANG WEI', '张伟', 'Zhang Wei')).toBe('match');
    expect(personCheckOf('ZHANG WEI', '张伟', null)).toBe('mismatch');   // 没有 pinyin 就不该蒙
  });

  it('报告印家长姓名的场景 → mismatch(交给人去 ack,系统不猜)', () => {
    expect(personCheckOf('张建国', '张小宝', null)).toBe('mismatch');
  });
});
