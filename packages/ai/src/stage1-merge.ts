import { Stage1Out, type Stage1OutT } from '@amr/contracts';
import { MAX_IMAGES_PER_REQUEST } from './models.js';

// spec m2-03 §5:多页与分批合并。**纯函数,无 IO** —— 合并规则必须确定性,
// 禁止"再发一次合并请求让模型自己合"(那会让同一批输入产出不同结果)。

export class MergeError extends Error {}

/** 按 page_no 升序切分为 ≤20 页的批次(m2-02 §3.4)。
 *  >20 会触发更严的逐图尺寸限制(每张 ≤2000px),使 ai 变体的 2576px 失效。 */
export function planBatches(pageNos: number[]): number[][] {
  const sorted = [...pageNos].sort((a, b) => a - b);
  if (new Set(sorted).size !== sorted.length) throw new MergeError('page_no 重复,无法分批');
  const out: number[][] = [];
  for (let i = 0; i < sorted.length; i += MAX_IMAGES_PER_REQUEST) {
    out.push(sorted.slice(i, i + MAX_IMAGES_PER_REQUEST));
  }
  return out;
}

/** 校验一批返回的 page_no 集合与送入的完全一致(审核 #003 A7)。
 *  模型自行编号是最隐蔽的失败:合并时才炸,且炸得莫名其妙。 */
export function assertBatchPages(sent: number[], got: Stage1OutT): void {
  const a = [...sent].sort((x, y) => x - y).join(',');
  const b = got.pages.map((p) => p.page_no).sort((x, y) => x - y).join(',');
  if (a !== b) throw new MergeError(`批次页号不符:送入 [${a}],返回 [${b}]`);
}

const firstNonNull = <T>(vals: (T | null)[]): T | null => vals.find((v) => v !== null) ?? null;

/**
 * 合并多批结果。`batches` 必须按送入顺序(即 page_no 升序)排列。
 * 单批直接返回其自身(仍走一遍校验,保证两条路径行为一致)。
 */
export function mergeBatches(batches: Stage1OutT[]): Stage1OutT {
  if (batches.length === 0) throw new MergeError('没有可合并的批次');

  // pages:按 page_no 拼接;同 page_no 出现两次即失败(m2-03 §5)
  const pages = batches.flatMap((b) => b.pages).sort((a, b) => a.page_no - b.page_no);
  const seen = new Set<number>();
  for (const p of pages) {
    if (seen.has(p.page_no)) throw new MergeError(`page_no 冲突:${p.page_no} 出现多次`);
    seen.add(p.page_no);
  }

  // doc_type:置信度最高者;并列取 page_no 最小的批次(batches 已按页序排列 ⇒ 取先出现者)
  let best = batches[0]!;
  for (const b of batches) {
    if (b.doc_type_confidence > best.doc_type_confidence) best = b;
  }

  return Stage1Out.parse({
    doc_type: best.doc_type,
    doc_type_confidence: best.doc_type_confidence,
    patient_name: firstNonNull(batches.map((b) => b.patient_name)),
    patient_sex: firstNonNull(batches.map((b) => b.patient_sex)),
    patient_age_text: firstNonNull(batches.map((b) => b.patient_age_text)),
    patient_identifiers: batches.flatMap((b) => b.patient_identifiers),
    facility_name_raw: firstNonNull(batches.map((b) => b.facility_name_raw)),
    department_raw: firstNonNull(batches.map((b) => b.department_raw)),
    sampled_on: firstNonNull(batches.map((b) => b.sampled_on)),
    reported_on: firstNonNull(batches.map((b) => b.reported_on)),
    event_at: firstNonNull(batches.map((b) => b.event_at)),
    summary: batches[0]!.summary,
    pages,
    // 按 page_no 归并,**不去重** —— 同一页出现两个同类 span 是合法的
    pii_spans: batches.flatMap((b) => b.pii_spans).sort((a, b) => a.page_no - b.page_no),
    unmodeled: batches.flatMap((b) => b.unmodeled).sort((a, b) => a.page_no - b.page_no),
    boundary_hint: firstNonNull(batches.map((b) => b.boundary_hint)),
  });
}
