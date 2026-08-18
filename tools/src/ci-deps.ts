// spec m0-99 B1/B7/B8:依赖规则、defineRoute 强制、_meta schema 覆盖 —— CI 断言。
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const failures: string[] = [];
const grep = (pattern: string, dir: string): string[] => {
  try {
    return execSync(`grep -rn --include='*.ts' -E ${JSON.stringify(pattern)} ${JSON.stringify(dir)}`, {
      encoding: 'utf-8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};

// B1a: packages 不 import apps
const pkgViolations = grep("from '(\\.\\./)*apps/|from \"@amr/api", path.join(root, 'packages'));
if (pkgViolations.length) failures.push(`packages 依赖 apps:\n${pkgViolations.join('\n')}`);

// B1b: contracts 仅依赖 zod
const contractsPkg = JSON.parse(readFileSync(path.join(root, 'packages/contracts/package.json'), 'utf-8'));
const deps = Object.keys(contractsPkg.dependencies ?? {});
if (deps.some((d) => d !== 'zod')) failures.push(`contracts 运行时依赖越界: ${deps.join(',')}`);

// B1c: apps/web 只依赖 @amr/contracts(m1-05 §1)
const webPkgPath = path.join(root, 'apps/web/package.json');
if (existsSync(webPkgPath)) {
  const webDeps = Object.keys((JSON.parse(readFileSync(webPkgPath, 'utf-8')).dependencies ?? {}) as Record<string, string>);
  const forbidden = webDeps.filter((d) => d.startsWith('@amr/') && d !== '@amr/contracts');
  if (forbidden.length) failures.push(`apps/web 依赖越界: ${forbidden.join(',')}`);
  const webImports = grep("from '@amr/(api|storage)", path.join(root, 'apps/web/src'));
  if (webImports.length) failures.push(`apps/web 直接 import 服务端包:\n${webImports.join('\n')}`);
}

// B7: 全部路由经 defineRoute —— 禁止裸注册
const bare = grep('app\\.(get|post|patch|delete|put)\\(', path.join(root, 'apps/api/src'));
const bareFiltered = bare.filter((l) => !l.includes('define-route.ts'));
if (bareFiltered.length) failures.push(`裸路由注册:\n${bareFiltered.join('\n')}`);

// B2: 迁移 SQL 的 CHECK 值列表 == contracts 枚举(单一来源断言)
const migrationSql = readFileSync(path.join(root, 'apps/api/drizzle/0000_init.sql'), 'utf-8');
const enumsTs = readFileSync(path.join(root, 'packages/contracts/src/enums.ts'), 'utf-8');
const expectChecks: Array<[string, string[]]> = [];
for (const m of enumsTs.matchAll(/export const (\w+) = z\.enum\(\[([\s\S]*?)\]\)/g)) {
  const values = [...m[2]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  expectChecks.push([m[1]!, values]);
}
for (const [name, values] of expectChecks) {
  if (name === 'MimeType') continue; // MimeType 不进 DB CHECK
  const inList = values.map((v) => `'${v}'`).join(', ');
  if (!migrationSql.includes(inList)) failures.push(`B2: 迁移 CHECK 与 contracts.${name} 不一致(期望 in (${inList}))`);
}

// B8: 代码中的每个 schema_version 在 gen-meta 的 schemas 清单中有对应文件(D10)
const genMeta = readFileSync(path.join(root, 'tools/src/gen-meta.ts'), 'utf-8');
const contractsIndex = readFileSync(path.join(root, 'packages/contracts/src/index.ts'), 'utf-8');
const versionsBlock = /SCHEMA_VERSIONS = \{([\s\S]*?)\}/.exec(contractsIndex)?.[1] ?? '';
for (const m of versionsBlock.matchAll(/(\w+): '([\d.]+)'/g)) {
  const name = m[1]!;
  if (!genMeta.includes(`SCHEMA_VERSIONS.${name}`)) {
    failures.push(`_meta schemas 缺 ${name}(D10/B8)`);
  }
}

// B12: spec 中出现的每个 D\d+ 在 design-debt 有对应行(防悬空引用复发)
const debts = new Set(
  [...readFileSync(path.join(root, 'docs/design-debt.md'), 'utf-8').matchAll(/^\| (D\d+) \|/gm)].map((m) => m[1]!),
);
for (const line of grep('\\bD[0-9]+\\b', path.join(root, 'specs'))) {
  for (const m of line.matchAll(/\bD(\d+)\b/g)) {
    if (!debts.has(`D${m[1]}`)) failures.push(`悬空设计债引用 D${m[1]}: ${line.slice(0, 100)}`);
  }
}

if (failures.length) {
  console.error('ci:deps 失败:\n' + failures.map((f) => '— ' + f).join('\n'));
  process.exit(1);
}
console.log('ci:deps 通过(B1/B2/B7/B8/B12)');
