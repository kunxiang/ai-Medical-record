import { normalizeIdentity, type PersonCheckT } from '@amr/contracts';

// spec m2-05 §1:归人对账。**禁止**因比对结果修改 document.person_id —— 一次也不行。
// "归人从不静默默认"是 M2 的验收句之一(ADR-041)。

/** m2-05 §1.3 定死的归一:NFKC → 小写 → 删空白 → 删逐字列出的分隔符。
 *  "去除常见分隔符"是散文不是字母表:折不折叠大小写直接决定 `ZHANG WEI` vs `Zhang Wei`
 *  是否 mismatch,`·` 收不收直接决定 `阿依古丽·买买提` 的归属(审核 #004 B-1)。 */
export function normalizeName(s: string): string {
  return normalizeIdentity(s);
}

/**
 * 确定性比对。**禁止引入任何相似度阈值** ——
 * 「张伟」vs「张玮」相似度很高但是两个人;把这种判断交给一个数字,
 * 等于用不可解释的阈值决定病历归谁。
 */
export function personCheckOf(
  patientName: string | null,
  displayName: string,
  namePinyin: string | null,
): PersonCheckT {
  if (patientName === null) return 'unknown';
  const n = normalizeName(patientName);
  if (n === normalizeName(displayName)) return 'match';
  if (namePinyin && n === normalizeName(namePinyin)) return 'match';
  return 'mismatch';
}
