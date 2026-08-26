import { createHash } from 'node:crypto';
import { canonicalJsonString, normalizeIdentity } from '@amr/contracts';

/** m2-05 §2.2：指纹只含报告机构原文的规范化值，不得混入城市等不可靠提示。 */
export function facilityFingerprint(rawName: string): string {
  const canonical = canonicalJsonString({ raw_name: normalizeIdentity(rawName) });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
