// CI 断言集合。两套 spec 的 B 编号不同,每条都标注出处以免再次错位:
//   m0-99 B1/B2/B7/B8  ·  m1-99 B1/B5/B6/B7/B8/B12
// 不在这里的:m1-99 B2(storage 性质测试)、B3/B4/B9/B10(验收脚本内)、B11(contracts 单测)。
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// m2-99 B1:AI 包只允许协议/SDK/schema 编译依赖，禁止穿透到 API/storage。
const aiPkgPath = path.join(root, 'packages/ai/package.json');
if (existsSync(aiPkgPath)) {
  const aiDeps = Object.keys((JSON.parse(readFileSync(aiPkgPath, 'utf-8')).dependencies ?? {}) as Record<string, string>);
  const allowed = new Set(['@amr/contracts', '@anthropic-ai/sdk', 'zod', 'zod-to-json-schema']);
  const bad = aiDeps.filter((d) => !allowed.has(d));
  if (bad.length) failures.push(`m2 B1: packages/ai 依赖越界: ${bad.join(',')}`);
  const aiImports = grep("from '@amr/(api|storage)", path.join(root, 'packages/ai/src'));
  if (aiImports.length) failures.push(`m2 B1: packages/ai 直接 import 服务端包:\n${aiImports.join('\n')}`);
}

// m2-99 B2: provider 默认模型 ID 只在 packages/ai/src/models.ts 出现。
// 扫描范围排除 fixtures(录制盒内必然含模型名)与 docs(审核 #003 A8)。
{
  const srcDirs = [
    ...readdirSync(path.join(root, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, 'packages', entry.name, 'src')),
    ...readdirSync(path.join(root, 'apps'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, 'apps', entry.name, 'src')),
    path.join(root, 'tools/src'),
  ].filter((d) => existsSync(d));
  const hits = srcDirs
    .flatMap((d) => grep("['\"](claude-[a-z0-9.-]+|deepseek-v[a-z0-9.-]+)['\"]", d))
    .filter((l) => !l.includes('packages/ai/src/models.ts'));
  if (hits.length) failures.push(`m2 B2: provider 默认模型 ID 只允许出现在 packages/ai/src/models.ts:\n${hits.join('\n')}`);
}

// m2-99 B10:M2 只做文档级抄写与归档，禁止提前写 observation 或引入单位换算。
{
  const sourceDirs = ['packages', 'apps', 'tools/src']
    .map((d) => path.join(root, d))
    .filter((d) => existsSync(d));
  const observationWrites = sourceDirs.flatMap((d) =>
    grep('\\.(insert|update|delete)\\(observation\\)', d))
    .filter((line) => !line.includes('/tools/src/ci-deps.ts:'));
  const unitConversions = sourceDirs.flatMap((d) =>
    grep('convert(Unit|Measurement)|normalizeUnit|toCanonicalUnit|单位换算', d))
    .filter((line) => !line.includes('/tools/src/ci-deps.ts:'));
  if (observationWrites.length) {
    failures.push(`m2 B10:发现 observation 表写入:\n${observationWrites.join('\n')}`);
  }
  if (unitConversions.length) {
    failures.push(`m2 B10:发现单位换算调用:\n${unitConversions.join('\n')}`);
  }
}

// B7: 全部路由经 defineRoute —— 禁止裸注册
const bare = grep('app\\.(get|post|patch|delete|put)\\(', path.join(root, 'apps/api/src'));
const bareFiltered = bare.filter((l) => !l.includes('define-route.ts'));
if (bareFiltered.length) failures.push(`裸路由注册:\n${bareFiltered.join('\n')}`);

// B2: 迁移 SQL 的 CHECK 值列表 == contracts 枚举(单一来源断言)
// ★ 必须读**全部**迁移文件:只读 0000 的话,后续里程碑新增的枚举永远查不到对应 CHECK,
//   而这条断言的价值恰恰在于"加了枚举却忘了迁移"时变红(M2 实现期实证)。
const drizzleDirForB2 = path.join(root, 'apps/api/drizzle');
const migrationSql = readdirSync(drizzleDirForB2)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(path.join(drizzleDirForB2, f), 'utf-8'))
  .join('\n');
const enumsTs = readFileSync(path.join(root, 'packages/contracts/src/enums.ts'), 'utf-8');
const expectChecks: Array<[string, string[]]> = [];
for (const m of enumsTs.matchAll(/export const (\w+) = z\.enum\(\[([\s\S]*?)\]\)/g)) {
  const values = [...m[2]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  expectChecks.push([m[1]!, values]);
}
// 不落 DB 列的枚举:它们只出现在 JSON 载荷或查询参数里,没有对应 CHECK 是正确的。
const NON_DB_ENUMS = new Set([
  'MimeType',   // 只在 sidecar 与请求体内
  'PiiKind',    // S1 工件的 JSON 内部
  'DateField',  // 列表查询参数
]);
for (const [name, values] of expectChecks) {
  if (NON_DB_ENUMS.has(name)) continue;
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

// m1-99 B5: journal 事件三处同步。registries 与 README 都由 gen-meta 从 JOURNAL_EVENT_REGISTRY
// 生成(结构上不会漏),真正会漏的是"往 JournalEvent 联合体里加了新事件却没进注册表"。
const journalTs = readFileSync(path.join(root, 'packages/contracts/src/journal.ts'), 'utf-8');
const registry = new Set(
  [...(/JOURNAL_EVENT_REGISTRY = \[([\s\S]*?)\]/.exec(journalTs)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!),
);
for (const m of journalTs.matchAll(/event: z\.literal\('([^']+)'\)/g)) {
  if (!registry.has(m[1]!)) failures.push(`B5: journal 事件 ${m[1]} 不在 JOURNAL_EVENT_REGISTRY(_meta 与 README 会漏)`);
}
const genMetaSrc = readFileSync(path.join(root, 'tools/src/gen-meta.ts'), 'utf-8');
if (!genMetaSrc.includes('JOURNAL_EVENT_REGISTRY')) {
  failures.push('B5: gen-meta 未从 JOURNAL_EVENT_REGISTRY 生成 registries/README');
}

// m1-99 B8: UI 文案不得承诺后台上传(队列是前台驱动的,ADR-046)
const webSrc = path.join(root, 'apps/web/src');
if (existsSync(webSrc)) {
  const promises = execSync(
    `grep -rn --include='*.tsx' --include='*.ts' -E '后台(自动)?上传|关掉也.*传|关闭.*继续上传|自动在后台' ${JSON.stringify(webSrc)} || true`,
    { encoding: 'utf-8' },
  ).trim().split('\n').filter(Boolean)
    // 注释里说明"不承诺后台上传"是允许的,只禁面向用户的字符串
    .filter((l) => !/^\S+:\d+:\s*(\/\/|\*|\/\*)/.test(l) && !l.includes('未承诺'));
  if (promises.length) failures.push(`B8: UI 文案承诺了后台上传:\n${promises.join('\n')}`);
}

// m1-99 B6: SW 配置 + 生产产物不含测试注入面
const viteConfigPath = path.join(root, 'apps/web/vite.config.ts');
if (existsSync(viteConfigPath)) {
  const vc = readFileSync(viteConfigPath, 'utf-8');
  if (!/navigateFallbackDenylist:\s*\[\s*\/\^\\\/api\\\//.test(vc)) {
    failures.push('B6: SW 缺 navigateFallbackDenylist: [/^\\/api\\//](导航回退会吞掉 API 404)');
  }
  if (!/runtimeCaching:\s*\[\s*\]/.test(vc)) failures.push('B6: SW runtimeCaching 必须为空(医疗内容禁止进 SW 缓存)');

  const outDir = mkdtempSync(path.join(tmpdir(), 'amr-prodbuild-'));
  try {
    execSync(`npx vite build --outDir ${JSON.stringify(outDir)} --emptyOutDir`, {
      cwd: path.join(root, 'apps/web'), stdio: 'pipe',
      env: { ...process.env, VITE_M1_TEST_HOOKS: '' },
    });
    // 只看会被执行的产物。.map 里出现 __amr 属正常(sourcesContent 保留原文),
    // 它不构成注入面 —— 真正要断言的是没有任何一行会跑的代码去挂 window.__amr。
    const leaked = execSync(
      `grep -rl --include='*.js' --include='*.html' --include='*.css' '__amr' ${JSON.stringify(outDir)} || true`,
      { encoding: 'utf-8' },
    ).trim().split('\n').filter(Boolean);
    if (leaked.length) failures.push(`B6: 生产产物含测试注入面 __amr:\n${leaked.join('\n')}`);
    const hookLeak = execSync(
      `grep -rl --include='*.js' 'installTestHooks' ${JSON.stringify(outDir)} || true`,
      { encoding: 'utf-8' },
    ).trim().split('\n').filter(Boolean);
    if (hookLeak.length) failures.push(`B6: 生产产物含 installTestHooks:\n${hookLeak.join('\n')}`);
  } catch (e) {
    failures.push(`B6: 生产构建失败: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// m1-99 B7: schema.ts 与迁移无漂移(drizzle-kit generate 不应产出新文件)
const drizzleDir = path.join(root, 'apps/api/drizzle');
if (existsSync(drizzleDir)) {
  const backup = mkdtempSync(path.join(tmpdir(), 'amr-drizzle-'));
  cpSync(drizzleDir, backup, { recursive: true });
  const before = readdirSync(drizzleDir).sort().join(',');
  try {
    execSync('npx drizzle-kit generate --name=ci_drift_probe', {
      cwd: path.join(root, 'apps/api'), stdio: 'pipe',
    });
  } catch (e) {
    failures.push(`B7: drizzle-kit generate 执行失败: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
  const after = readdirSync(drizzleDir).sort().join(',');
  if (before !== after) {
    failures.push(`B7: schema.ts 与迁移漂移 —— generate 产出了新迁移(${after.replace(before, '').replace(/^,/, '')})`);
    rmSync(drizzleDir, { recursive: true, force: true });
    cpSync(backup, drizzleDir, { recursive: true });   // 复原,不把探针文件留在仓库里
  }
  rmSync(backup, { recursive: true, force: true });
}

if (failures.length) {
  console.error('ci:deps 失败:\n' + failures.map((f) => '— ' + f).join('\n'));
  process.exit(1);
}
console.log('ci:deps 通过(m0-99 B1/B2/B7/B8 · m1-99 B1/B5/B6/B7/B8/B12 · m2-99 B1/B2/B10)');
