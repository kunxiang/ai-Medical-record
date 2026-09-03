// 真实血常规单据上的项目名必须能被严格解析 —— 解析不出来的行会:
//   1) 无法参与跨行自洽校验 ⇒ 退化成"需人工确认";
//   2) 落库时 concept_code 为空 ⇒ 堆进「待整理指标名称」要用户逐个下拉选择。
// 两者都是把不可能完成的任务推给用户,所以这批名字值得一条回归。
import { describe, expect, it } from 'vitest';
import { conceptByExactName } from '../src/concepts.js';

/** 取自本仓第一份真实血常规(龙岗区第二人民医院,2026-08-21)的项目名原文 */
const REAL_CBC: ReadonlyArray<readonly [string, string]> = [
  ['白细胞(WBC)', 'WBC'],
  ['中性粒细胞比例(Neu%)', 'NEUT_PCT'],
  ['淋巴细胞比例(Lym%)', 'LYMPH_PCT'],
  ['单核细胞比例(Mon%)', 'MONO_PCT'],
  ['嗜酸性粒细胞比例(Eos%)', 'EO_PCT'],
  ['嗜碱性粒细胞比例(Bas%)', 'BASO_PCT'],
  ['中性粒细胞绝对值(Neu#)', 'NEUT_ABS'],
  ['淋巴细胞绝对值(Lym#)', 'LYMPH_ABS'],
  ['单核细胞绝对值(Mon#)', 'MONO_ABS'],
  ['嗜酸性粒细胞绝对值(Eos#)', 'EO_ABS'],
  ['嗜碱性粒细胞绝对值(Bas#)', 'BASO_ABS'],
  ['红细胞(RBC)', 'RBC'],
  ['血红蛋白(HGB)', 'HEMOGLOBIN'],
  ['红细胞压积(HCT)', 'HCT'],
  ['红细胞平均体积(MCV)', 'MCV'],
  ['平均血红蛋白含量(MCH)', 'MCH'],
  ['平均血红蛋白浓度(MCHC)', 'MCHC'],
  ['血小板(PLT)', 'PLT'],
  ['血小板平均体积(MPV)', 'MPV'],
  ['血小板压积(PCT)', 'PCT_PLATELET'],
  ['大血小板比例(P-LCR)', 'P_LCR'],
  ['大血小板数目(P-LCC)', 'P_LCC'],
  ['中性粒细胞与淋巴细胞比值(NLR)', 'NLR'],
  ['血小板与淋巴细胞比值(PLR)', 'PLR'],
];

describe('化验项目名的严格解析', () => {
  it.each(REAL_CBC)('%s → %s', (name, code) => {
    expect(conceptByExactName(name)?.code).toBe(code);
  });

  it('括号内缩写单独出现时也能解析', () => {
    expect(conceptByExactName('WBC')?.code).toBe('WBC');
    expect(conceptByExactName('Neu%')?.code).toBe('NEUT_PCT');
  });

  it('全角括号与空白不影响解析', () => {
    expect(conceptByExactName('  白细胞（WBC） ')?.code).toBe('WBC');
  });

  it.each([
    ['红细胞变异系数(RDW-CV)', 'RDW_CV'],
    ['分布宽度标准差(RDW-SD)', 'RDW_SD'],
    ['血小板分布宽度(PDW)', 'PDW'],
    ['C反应蛋白(CRP)', 'CRP'],
  ])('无冗余但仍应识别:%s → %s', (name, code) => {
    // 这几项交叉验不了(review_status 会是 unverified),但识别得出来就不该让人手工映射
    expect(conceptByExactName(name)?.code).toBe(code);
  });

  it('★ 认不出就返回 null,绝不猜 —— 猜错会给未验证的值盖上已验证的章', () => {
    expect(conceptByExactName('流感A+B抗原检测')).toBeNull();
    expect(conceptByExactName('本院自定义项目XYZ')).toBeNull();
    expect(conceptByExactName('')).toBeNull();
  });

  it('★ 不做模糊包含匹配 —— "白" 不能命中 "白细胞"', () => {
    expect(conceptByExactName('白')).toBeNull();
    expect(conceptByExactName('细胞')).toBeNull();
  });
});
