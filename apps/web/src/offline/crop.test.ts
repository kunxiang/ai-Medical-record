import { describe, expect, it } from 'vitest';
import type { CropQuadT } from '@amr/contracts';
import { fullFrameQuad, isPlausibleQuad, rotateQuad } from './crop.js';

/** 顺序恒为 左上、右上、右下、左下 */
const q = (pts: Array<[number, number]>): CropQuadT =>
  pts.map(([x, y]) => ({ x, y })) as CropQuadT;

// 一个偏左上的非对称框 —— 对称的框转完还是自己,测不出顺序错误
const ASYM = q([[0.1, 0.2], [0.7, 0.15], [0.75, 0.8], [0.05, 0.85]]);

describe('rotateQuad', () => {
  it('90° 顺时针:原左上角落到右上角,且数组第 0 位仍是新的左上角', () => {
    const r = rotateQuad(ASYM, 90);
    // 原左上 (0.1,0.2) → (1-0.2, 0.1) = (0.8,0.1),在新图里是右上 ⇒ 数组第 1 位
    expect(r[1]!.x).toBeCloseTo(0.8);
    expect(r[1]!.y).toBeCloseTo(0.1);
    // 新的左上角来自原来的左下角 (0.05,0.85) → (1-0.85, 0.05) = (0.15,0.05)
    expect(r[0]!.x).toBeCloseTo(0.15);
    expect(r[0]!.y).toBeCloseTo(0.05);
  });

  it('-90° 与 270° 等价', () => {
    expect(rotateQuad(ASYM, -90)).toEqual(rotateQuad(ASYM, 270));
  });

  it('转四次 90° 回到原点(顺序与坐标都还原)', () => {
    let r: CropQuadT = ASYM;
    for (let i = 0; i < 4; i += 1) r = rotateQuad(r, 90);
    r.forEach((p, i) => {
      expect(p.x).toBeCloseTo(ASYM[i]!.x);
      expect(p.y).toBeCloseTo(ASYM[i]!.y);
    });
  });

  it('180° = 两次 90°', () => {
    const twice = rotateQuad(rotateQuad(ASYM, 90), 90);
    const once = rotateQuad(ASYM, 180);
    once.forEach((p, i) => {
      expect(p.x).toBeCloseTo(twice[i]!.x);
      expect(p.y).toBeCloseTo(twice[i]!.y);
    });
  });

  it('旋转后仍在 [0,1] 内 —— 越界会被 contracts 的 schema 拒收', () => {
    for (const deg of [90, 180, 270]) {
      for (const p of rotateQuad(ASYM, deg)) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(1);
      }
    }
  });

  it('0° 原样返回', () => {
    expect(rotateQuad(ASYM, 0)).toBe(ASYM);
  });
});

describe('isPlausibleQuad —— 不可信时必须退回不裁,而不是给一个烂框', () => {
  it('接受一个正常的单据框', () => {
    expect(isPlausibleQuad(q([[0.1, 0.08], [0.9, 0.1], [0.88, 0.92], [0.12, 0.9]]))).toBe(true);
  });

  it('拒绝整幅(四角贴边 ⇒ 检测器其实什么也没找到)', () => {
    expect(isPlausibleQuad(fullFrameQuad())).toBe(false);
  });

  it('拒绝过小的框(退化检测会把提取质量打穿)', () => {
    expect(isPlausibleQuad(q([[0.4, 0.4], [0.5, 0.4], [0.5, 0.5], [0.4, 0.5]]))).toBe(false);
  });

  it('拒绝细长条(长宽比不像单据)', () => {
    expect(isPlausibleQuad(q([[0.02, 0.4], [0.98, 0.4], [0.98, 0.52], [0.02, 0.52]]))).toBe(false);
  });

  it('拒绝自交的四边形(角点顺序错乱)', () => {
    expect(isPlausibleQuad(q([[0.1, 0.1], [0.9, 0.9], [0.9, 0.1], [0.1, 0.9]]))).toBe(false);
  });

  it('拒绝越界与 NaN', () => {
    expect(isPlausibleQuad(q([[-0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]))).toBe(false);
    expect(isPlausibleQuad(q([[Number.NaN, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]))).toBe(false);
  });
});
