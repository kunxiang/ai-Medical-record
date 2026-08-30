import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const FONT_PACKAGE_PATH = '@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff';

/** Locked by pnpm-lock.yaml; never falls back to a host font. */
export const VISIT_SUMMARY_FONT_BYTES = readFileSync(require.resolve(FONT_PACKAGE_PATH));
export const VISIT_SUMMARY_FONT_ID = 'noto-sans-sc-chinese-simplified-400@5.2.8';
export const VISIT_SUMMARY_FONT_MANIFEST_HASH = createHash('sha256')
  .update(VISIT_SUMMARY_FONT_ID)
  .update('\0')
  .update(VISIT_SUMMARY_FONT_BYTES)
  .digest('hex');

export const VISIT_SUMMARY_RENDERER_ID = 'medireco-visit-summary' as const;
export const VISIT_SUMMARY_RENDERER_VERSION = '1.0.0' as const;
