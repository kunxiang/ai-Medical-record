// 扫描 prompts/**/{id}@{version}.md,重算 sha256 写入 manifest.json。
// 改 prompt 之后必须跑一次 —— 否则运行时完整性校验会拒绝启动(这是故意的)。
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts');
const NAME = /^([a-z0-9-]+)@(\d+)\.md$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const abs = path.join(dir, n);
    return statSync(abs).isDirectory() ? walk(abs) : [abs];
  });
}

const entries = walk(ROOT)
  .filter((f) => f.endsWith('.md'))
  .map((abs) => {
    const base = path.basename(abs);
    const m = NAME.exec(base);
    if (!m) throw new Error(`prompt 文件名不合规(须 {id}@{version}.md): ${base}`);
    const text = readFileSync(abs, 'utf-8');
    return {
      id: m[1]!,
      version: Number(m[2]),
      file: path.relative(ROOT, abs),
      sha256: createHash('sha256').update(text, 'utf-8').digest('hex'),
    };
  })
  .sort((a, b) => (a.id === b.id ? a.version - b.version : a.id.localeCompare(b.id)));

writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(entries, null, 2) + '\n');
console.log(`prompt manifest: ${entries.length} 条`);
for (const e of entries) console.log(`  ${e.id}@${e.version}  ${e.sha256.slice(0, 12)}  ${e.file}`);
