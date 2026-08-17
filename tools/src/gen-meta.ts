// spec m0-04 §5:_meta/ 自述层落桶。schemas 由 contracts zod 导出;registries 文件名=部署日(同日幂等覆盖)。
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  CaptureSidecar, CorrectionSidecar, DocType, JOURNAL_EVENT_REGISTRY, JournalEvent,
  ManifestLine, MimeType, PageSidecar, PersonSidecar, SCHEMA_VERSIONS, SLUG_ALPHABET,
} from '@amr/contracts';
import { canonicalJson } from '@amr/storage';
import { adminClient, BUCKET } from './s3-admin.js';

const s3 = adminClient();

const put = (key: string, body: Buffer, contentType: string) =>
  s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));

const schemas: Array<[string, unknown]> = [
  [`_meta/schemas/${SCHEMA_VERSIONS.capture}/capture.json`, zodToJsonSchema(CaptureSidecar)],
  [`_meta/schemas/${SCHEMA_VERSIONS.page}/page.json`, zodToJsonSchema(PageSidecar)],
  [`_meta/schemas/${SCHEMA_VERSIONS.person}/person.json`, zodToJsonSchema(PersonSidecar)],
  [`_meta/schemas/${SCHEMA_VERSIONS.journal}/journal.json`, zodToJsonSchema(JournalEvent)],
  [`_meta/schemas/${SCHEMA_VERSIONS.manifest}/manifest.json`, zodToJsonSchema(ManifestLine)],
  [`_meta/schemas/${SCHEMA_VERSIONS.correction}/correction.json`, zodToJsonSchema(CorrectionSidecar)],
];
for (const [key, schema] of schemas) await put(key, canonicalJson(schema), 'application/json');

const today = new Date().toISOString().slice(0, 10);
await put(
  `_meta/registries/${today}.json`,
  canonicalJson({
    schema_version: '1.0',
    generated_on: today,
    doc_types: DocType.options,
    journal_events: JOURNAL_EVENT_REGISTRY,
    slug_alphabet: SLUG_ALPHABET,
    mime_whitelist: MimeType.options,
    schema_versions: SCHEMA_VERSIONS,
  }),
  'application/json',
);

const readme = `# 医疗档案桶 · 自述(_meta/README.md)

本文件由 tools/gen-meta.ts 生成,禁止手改。这是解读本桶的钥匙 —— 应用死了,这份说明还在。

## 布局(三层插件架构,ADR-045)

- \`people/{slug}/\` —— L1 档案:原件(page-*.jpg / audio/*.m4a)+ 拍摄事实 sidecar(capture.json,
  只含上传瞬间已知的事实,没有任何 AI 观点)+ 人工层 journal + _person.json 全量快照。
- \`derived/\` —— L2 派生:AI 提取、转写、缩略图、视图。**全部可再生,可整体丢弃重建。**
- \`_index/manifests/*.jsonl\` —— 档案事实事件流(add / person_correct),数据库全丢时的重建入口。
- \`_index/people.json\` —— slug → 姓名 映射。
- \`_meta/schemas/\` —— 各 JSON 文件的 JSON Schema 快照,按 schema_version 分目录。
- \`_incoming/\`、\`_probe/\` —— 暂存与自检,非档案,打包时不带。

## 回放规则

1. manifests 按 created_at 时间序回放;**event_id 相同的行只应用一次**(幂等)。
2. 同 doc_short_id 的重复 add 行幂等合并;后写覆盖先写(person_correct 改归属)。
3. add 行若无对应 capture.json 佐证 → 不建档案记录,列入对账报告(可能是未提交成功的幽灵行)。
4. journal(people/{slug}/journal/*.jsonl)同规则回放,恢复人工层(person 编辑等)。
5. 权威归属 = manifests 回放结果;key 前缀与 capture.json 中的 person 只是拍摄时刻断言。

## journal 事件注册表

${JOURNAL_EVENT_REGISTRY.map((e) => `- \`${e}\``).join('\n')}

## 校验

每个 page-NN.json 的 sha256 应与同名原件实际内容一致;capture.json 的 pages[] 与目录内文件一一对应。
`;
await put('_meta/README.md', Buffer.from(readme, 'utf-8'), 'text/markdown');
console.log(`_meta/ 已落桶(schemas ×${schemas.length} + registries/${today}.json + README.md)`);
