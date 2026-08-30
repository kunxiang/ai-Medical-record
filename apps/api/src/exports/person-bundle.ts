import { createHash } from 'node:crypto';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { ZipArchive, type Archiver, type EntryData } from 'archiver';
import {
  DecisionLine, ManifestLine, PersonBundleManifest,
  canonicalJsonString,
  type PersonBundleManifestT,
} from '@amr/contracts';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { document, documentPage, person } from '../db/schema.js';
import { getObjectStream, getObjectText, listKeys } from '../s3.js';
import { notFound } from '../errors.js';
import { filterDecisionForPerson } from './bundle-filter.js';

interface PlannedEntry {
  path: string;
  sourceKey: string | null;
  content?: Buffer;
}

function safeArchivePath(key: string): boolean {
  return key.length > 0 && !key.startsWith('/') && !key.split('/').includes('..');
}

function jsonl(lines: unknown[]): Buffer {
  return Buffer.from(lines.map((line) => canonicalJsonString(line)).join('\n') + '\n');
}

async function buildPlan(personId: string): Promise<{
  personSlug: string;
  entries: PlannedEntry[];
  gaps: PersonBundleManifestT['gaps'];
}> {
  const owner = (await db.select({ slug: person.slug }).from(person)
    .where(eq(person.id, personId)).limit(1))[0];
  if (!owner) throw notFound();
  const docs = await db.select({
    id: document.id, shortId: document.shortId, storageKey: documentPage.storageKey,
    facilityNameRaw: document.facilityNameRaw,
  }).from(document)
    .leftJoin(documentPage, eq(documentPage.documentId, document.id))
    .where(eq(document.personId, personId));
  const targetShortIds = new Set(docs.map((row) => row.shortId));
  const targetFacilityRawNames = new Set(docs.map((row) => row.facilityNameRaw).filter((value): value is string => !!value));
  const allKeys = await listKeys('');
  const keySet = new Set(allKeys);
  const selectedKeys = new Set<string>();
  const gaps: PersonBundleManifestT['gaps'] = [];

  const manifestEntries: PlannedEntry[] = [];
  const manifestPrefixes = new Map<string, string>();
  for (const key of allKeys.filter((item) => /^_index\/manifests\/[^/]+\.jsonl$/.test(item)).sort()) {
    const object = await getObjectText(key);
    if (!object) continue;
    const kept: unknown[] = [];
    for (const raw of object.text.split('\n').filter(Boolean)) {
      let parsedJson: unknown;
      try { parsedJson = JSON.parse(raw); } catch { continue; }
      const parsed = ManifestLine.safeParse(parsedJson);
      if (!parsed.success || !targetShortIds.has(parsed.data.doc_short_id)) continue;
      kept.push(parsed.data);
      if (parsed.data.op === 'add') manifestPrefixes.set(parsed.data.doc_short_id, parsed.data.prefix);
    }
    if (kept.length > 0) manifestEntries.push({ path: key, sourceKey: null, content: jsonl(kept) });
  }
  for (const shortId of targetShortIds) {
    const prefix = manifestPrefixes.get(shortId);
    if (!prefix) {
      gaps.push({ key: shortId, reason: 'manifest_missing' });
      continue;
    }
    for (const key of allKeys) if (key.startsWith(prefix)) selectedKeys.add(key);
  }

  const personPrefix = `people/${owner.slug}/`;
  for (const key of allKeys) {
    if (!key.startsWith(personPrefix)) continue;
    const relative = key.slice(personPrefix.length);
    if (relative === '_person.json' || relative.startsWith('journal/') || relative.startsWith('context/')) {
      selectedKeys.add(key);
    }
  }
  for (const row of docs) {
    if (!row.storageKey) continue;
    selectedKeys.add(row.storageKey);
    const slash = row.storageKey.lastIndexOf('/');
    const filename = row.storageKey.slice(slash + 1);
    const pageMeta = `${row.storageKey.slice(0, slash + 1)}${filename.replace(/\.[^.]+$/, '.json')}`;
    if (keySet.has(pageMeta)) selectedKeys.add(pageMeta);
    else gaps.push({ key: pageMeta, reason: 'object_missing' });
  }
  for (const key of allKeys) if (key.startsWith('_meta/')) selectedKeys.add(key);

  const decisionEntries: PlannedEntry[] = [];
  for (const key of allKeys.filter((item) => /^_index\/decisions\/[^/]+\.jsonl$/.test(item)).sort()) {
    const object = await getObjectText(key);
    if (!object) continue;
    const kept: unknown[] = [];
    for (const raw of object.text.split('\n').filter(Boolean)) {
      let parsedJson: unknown;
      try { parsedJson = JSON.parse(raw); } catch { continue; }
      const parsed = DecisionLine.safeParse(parsedJson);
      if (!parsed.success) continue;
      const filtered = filterDecisionForPerson(parsed.data, personId, targetFacilityRawNames);
      if (filtered) kept.push(filtered);
    }
    if (kept.length > 0) decisionEntries.push({ path: key, sourceKey: null, content: jsonl(kept) });
  }

  const originalPersonMap = await getObjectText('_index/people.json');
  let filteredPersonMap: Record<string, unknown> = {
    schema_version: '1.0', people: [{ slug: owner.slug }],
  };
  if (originalPersonMap) {
    try {
      const parsed = JSON.parse(originalPersonMap.text) as Record<string, unknown>;
      const people = Array.isArray(parsed.people)
        ? parsed.people.filter((item) => (
            !!item && typeof item === 'object'
            && (item as Record<string, unknown>).slug === owner.slug
          ))
        : [];
      filteredPersonMap = { ...parsed, people };
    } catch {
      gaps.push({ key: '_index/people.json', reason: 'invalid_content' });
    }
  }
  const personMap = Buffer.from(canonicalJsonString(filteredPersonMap));
  const entries: PlannedEntry[] = [
    ...[...selectedKeys].sort().map((key) => ({ path: key, sourceKey: key })),
    ...manifestEntries,
    ...decisionEntries,
    { path: '_index/people.json', sourceKey: null, content: personMap },
  ];
  return { personSlug: owner.slug, entries, gaps };
}

function appendAndWait(
  archive: Archiver,
  source: Buffer | Readable,
  name: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: EntryData) => {
      if (entry.name !== name) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      archive.off('entry', onEntry);
      archive.off('error', onError);
    };
    archive.on('entry', onEntry);
    archive.on('error', onError);
    archive.append(source, { name });
  });
}

export async function createPersonBundle(personId: string): Promise<{
  filename: string;
  stream: Readable;
}> {
  const plan = await buildPlan(personId);
  const output = new PassThrough();
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.pipe(output);
  void (async () => {
    const manifestEntries: PersonBundleManifestT['entries'] = [];
    try {
      for (const entry of plan.entries) {
        if (!safeArchivePath(entry.path)) {
          plan.gaps.push({ key: entry.path, reason: 'invalid_key' });
          continue;
        }
        if (entry.content) {
          await appendAndWait(archive, entry.content, entry.path);
          manifestEntries.push({
            path: entry.path, source_key: null, byte_size: entry.content.length,
            sha256: createHash('sha256').update(entry.content).digest('hex'),
          });
          continue;
        }
        const source = await getObjectStream(entry.sourceKey!);
        if (!source) {
          plan.gaps.push({ key: entry.sourceKey!, reason: 'object_missing' });
          continue;
        }
        const hash = createHash('sha256');
        let byteSize = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            byteSize += chunk.length;
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        source.pipe(meter);
        await appendAndWait(archive, meter, entry.path);
        manifestEntries.push({
          path: entry.path, source_key: entry.sourceKey,
          byte_size: byteSize, sha256: hash.digest('hex'),
        });
      }
      const manifest = PersonBundleManifest.parse({
        schema_version: '1.0', person_id: personId, person_slug: plan.personSlug,
        created_at: new Date().toISOString(), entries: manifestEntries, gaps: plan.gaps,
        excludes: ['derived/**', '_incoming/**', '_probe/**', 'processing jobs/suggestions'],
      });
      await appendAndWait(
        archive,
        Buffer.from(canonicalJsonString(manifest)),
        'bundle-manifest.json',
      );
      await archive.finalize();
    } catch (error) {
      archive.abort();
      output.destroy(error as Error);
    }
  })();
  return { filename: `medical-record-${plan.personSlug}.zip`, stream: output };
}
