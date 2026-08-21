// spec m2-99 B4:篡改 prompt 而不改 manifest ⇒ 启动失败。
// 这条断言必须能真的红 —— 所以用故障注入验证,而不是只测 happy path。
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { __resetPromptCache, getPrompt, loadPrompts, PromptIntegrityError } from '../src/prompts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'prompts/s1/s1-classify@1.md');
const BACKUP = TARGET + '.bak';

afterEach(() => {
  try {
    copyFileSync(BACKUP, TARGET);
    writeFileSync(BACKUP, '');
  } catch { /* 未备份则无需还原 */ }
  __resetPromptCache();
});

describe('prompt 完整性(m2-99 B4)', () => {
  it('清单一致时可正常载入', () => {
    const all = loadPrompts();
    expect(all.size).toBeGreaterThan(0);
    const p = getPrompt('s1-classify');
    expect(p.version).toBe(1);
    expect(p.text).toContain('只抄写');
  });

  it('省略版本号时取最高版本', () => {
    expect(getPrompt('s1-classify').version).toBe(getPrompt('s1-classify', 1).version);
  });

  it('未注册的 prompt 抛错', () => {
    expect(() => getPrompt('does-not-exist')).toThrow(PromptIntegrityError);
    expect(() => getPrompt('s1-classify', 99)).toThrow(PromptIntegrityError);
  });

  it('★ 篡改 prompt 而不改 manifest ⇒ 抛 PromptIntegrityError', () => {
    copyFileSync(TARGET, BACKUP);
    writeFileSync(TARGET, readFileSync(TARGET, 'utf-8') + '\n偷偷加一句会改变行为的话。\n');
    __resetPromptCache();
    expect(() => loadPrompts()).toThrow(PromptIntegrityError);
    // 错误信息必须点明"改了就要改版本号",否则下一个人只会把校验关掉
    expect(() => loadPrompts()).toThrow(/版本号/);
  });
});
