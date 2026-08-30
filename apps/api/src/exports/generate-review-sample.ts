import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonString } from '@amr/contracts';
import {
  VISIT_SUMMARY_FONT_ID,
  VISIT_SUMMARY_FONT_MANIFEST_HASH,
  VISIT_SUMMARY_RENDERER_ID,
  VISIT_SUMMARY_RENDERER_VERSION,
} from './font.js';
import { renderVisitSummary } from './renderer.js';
import { visitSummaryReviewSample } from './review-sample.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const outputDir = resolve(process.argv[2] ?? resolve(repoRoot, 'specs/p0-p4-core/evidence'));

await mkdir(outputDir, { recursive: true });

const artifacts: Array<{
  file: string;
  format: 'pdf' | 'png';
  sha256: string;
  content_hash: string;
  byte_size: number;
}> = [];

for (const format of ['pdf', 'png'] as const) {
  const manifest = visitSummaryReviewSample(format);
  const rendered = await renderVisitSummary(manifest);
  const file = `visit-summary-synthetic.${rendered.extension}`;
  await writeFile(resolve(outputDir, file), rendered.bytes);
  await writeFile(
    resolve(outputDir, `visit-summary-synthetic.${format}.manifest.json`),
    `${canonicalJsonString(manifest)}\n`,
  );
  artifacts.push({
    file,
    format,
    sha256: rendered.sha256,
    content_hash: rendered.contentHash,
    byte_size: rendered.bytes.length,
  });
}

await writeFile(resolve(outputDir, 'provenance.json'), `${JSON.stringify({
  schema_version: '1.0',
  synthetic: true,
  contains_real_person_data: false,
  purpose: 'P4-11/P4-12 layout and readability preflight only; not a medical example',
  renderer_id: VISIT_SUMMARY_RENDERER_ID,
  renderer_version: VISIT_SUMMARY_RENDERER_VERSION,
  font_id: VISIT_SUMMARY_FONT_ID,
  font_manifest_hash: VISIT_SUMMARY_FONT_MANIFEST_HASH,
  artifacts,
}, null, 2)}\n`);

for (const artifact of artifacts) {
  process.stdout.write(`${artifact.sha256}  ${artifact.file}\n`);
}
