// m2-99 B14:录制盒独立确定性 PII 扫描，不信任模型自报 pii_spans。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cassetteRoot = path.join(root, 'fixtures/m2/cassettes');
const patterns = {
  phone: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  idCard: /(?<!\d)\d{17}[\dXx](?!\d)/g,
};

function filesBelow(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const target = path.join(directory, name);
    return statSync(target).isDirectory() ? filesBelow(target) : [target];
  });
}

const failures: string[] = [];
const files = filesBelow(cassetteRoot).filter((file) => file.endsWith('.json'));
let recorded = 0;
let synthetic = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const provenance = (JSON.parse(text) as { provenance?: string }).provenance;
  if (provenance === 'recorded') recorded += 1;
  else if (provenance === 'synthetic') synthetic += 1;
  else failures.push(`${path.relative(root, file)} 缺少合法 provenance(recorded/synthetic)`);
  for (const [kind, pattern] of Object.entries(patterns)) {
    pattern.lastIndex = 0;
    const hit = pattern.exec(text);
    if (hit) failures.push(`${path.relative(root, file)} 含未遮蔽 ${kind}: offset=${hit.index}`);
  }
}
if (failures.length) {
  console.error('M2 cassette PII 扫描失败:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log(`M2 cassette PII 扫描通过(${files.length} 个 JSON；recorded=${recorded}，synthetic=${synthetic})`);
