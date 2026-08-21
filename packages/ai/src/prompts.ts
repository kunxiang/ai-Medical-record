import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// spec m2-02 §4:prompt 版本管理。
//
// 为什么要做完整性校验而不是"读文件就用":prompt 是提取行为的一部分。
// 改了 prompt 而版本号没动,等于让两批数据的产出口径不同却无从分辨 ——
// 事后拿着两批结果做对比时,你不知道差异来自模型、来自单据,还是来自你自己改过的那句话。

export interface LoadedPrompt {
  id: string;
  version: number;
  sha256: string;
  text: string;
}

interface ManifestEntry {
  id: string;
  version: number;
  file: string;
  sha256: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
// dist/ 与 src/ 都在 packages/ai 下一层 ⇒ 上跳一级即包根
const PKG_ROOT = path.resolve(HERE, '..');
const PROMPTS_DIR = path.join(PKG_ROOT, 'prompts');

export class PromptIntegrityError extends Error {}

let cache: Map<string, LoadedPrompt> | null = null;

/** 载入并校验全部 prompt。任何一项 sha256 不符 ⇒ **抛错,不降级**。 */
export function loadPrompts(): Map<string, LoadedPrompt> {
  if (cache) return cache;
  const manifestPath = path.join(PROMPTS_DIR, 'manifest.json');
  let entries: ManifestEntry[];
  try {
    entries = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
  } catch (e) {
    throw new PromptIntegrityError(`prompt 清单不可读: ${manifestPath}`);
  }

  const out = new Map<string, LoadedPrompt>();
  for (const e of entries) {
    const abs = path.join(PROMPTS_DIR, e.file);
    let text: string;
    try {
      text = readFileSync(abs, 'utf-8');
    } catch {
      throw new PromptIntegrityError(`prompt 文件缺失: ${e.file}`);
    }
    const actual = createHash('sha256').update(text, 'utf-8').digest('hex');
    if (actual !== e.sha256) {
      throw new PromptIntegrityError(
        `prompt 内容与清单不符: ${e.file}\n  清单 ${e.sha256}\n  实际 ${actual}\n` +
        `  —— 改了 prompt 就必须同时改版本号并重跑 gen-prompt-manifest。`,
      );
    }
    out.set(key(e.id, e.version), { id: e.id, version: e.version, sha256: e.sha256, text });
  }
  cache = out;
  return out;
}

const key = (id: string, version: number) => `${id}@${version}`;

/** 取指定版本;省略 version 则取该 id 的最高版本。 */
export function getPrompt(id: string, version?: number): LoadedPrompt {
  const all = loadPrompts();
  if (version !== undefined) {
    const hit = all.get(key(id, version));
    if (!hit) throw new PromptIntegrityError(`未注册的 prompt: ${key(id, version)}`);
    return hit;
  }
  const candidates = [...all.values()].filter((p) => p.id === id);
  if (candidates.length === 0) throw new PromptIntegrityError(`未注册的 prompt: ${id}`);
  return candidates.reduce((a, b) => (b.version > a.version ? b : a));
}

/** 仅供测试:清空缓存,使下一次 load 重新读盘 */
export function __resetPromptCache(): void {
  cache = null;
}
