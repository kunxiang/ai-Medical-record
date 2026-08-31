// m2-99 A1/B11:送入模型的 ai 派生图必须旋正、去元数据且可确定性重建。
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PageCropT } from '@amr/contracts';

let renderDerivative: typeof import('../src/derivatives.js')['renderDerivative'];
let DERIVATIVE_SPEC: typeof import('../src/derivatives.js')['DERIVATIVE_SPEC'];

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-auth-secret-that-is-at-least-32-bytes';
  ({ renderDerivative, DERIVATIVE_SPEC } = await import('../src/derivatives.js'));
});

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');

async function orientationSixJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1200,
      height: 800,
      channels: 3,
      background: { r: 240, g: 245, b: 250 },
    },
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 95 })
    .toBuffer();
}

describe('ai derivative invariants', () => {
  it('A1 Orientation=6 旋正为竖向、限制长边并剥除 EXIF', async () => {
    const output = await renderDerivative(await orientationSixJpeg(), 'ai');
    const metadata = await sharp(output).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.height).toBeGreaterThan(metadata.width ?? 0);
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(
      DERIVATIVE_SPEC.ai.maxEdge,
    );
    expect(metadata.exif).toBeUndefined();
  });

  it('B11 同一源图的 ai 派生字节与 sha256 完全一致', async () => {
    const source = await orientationSixJpeg();
    const first = await renderDerivative(source, 'ai');
    const second = await renderDerivative(source, 'ai');

    expect(first.equals(second)).toBe(true);
    expect(sha256(first)).toBe(sha256(second));
  });
});

/** 顺序恒为 左上、右上、右下、左下(归一化,旋正后坐标系) */
const crop = (x: number, y: number, w: number, h: number): PageCropT => ({
  source: 'human',
  quad: [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ],
});

describe('p5-01 裁切:只作用于 ai,且不裁时字节与加这个功能之前一致', () => {
  it('crop=null 与不传 crop 完全一致 —— 存量文档的回归闸门', async () => {
    const source = await orientationSixJpeg();
    expect((await renderDerivative(source, 'ai')).equals(
      await renderDerivative(source, 'ai', null))).toBe(true);
  });

  it('同源图 + 同 crop 两次渲染字节一致(B11 扩展到裁切路径)', async () => {
    const source = await orientationSixJpeg();
    const c = crop(0.1, 0.1, 0.6, 0.7);
    const first = await renderDerivative(source, 'ai', c);
    const second = await renderDerivative(source, 'ai', c);
    expect(first.equals(second)).toBe(true);
    expect(sha256(first)).toBe(sha256(second));
  });

  it('裁切确实生效:输出长宽比跟随裁切框,而不是原图', async () => {
    const source = await orientationSixJpeg();          // Orientation=6 ⇒ 旋正后 800×1200
    // 取上半部分的一个宽扁框
    const out = await renderDerivative(source, 'ai', crop(0.1, 0.1, 0.8, 0.2));
    const m = await sharp(out).metadata();
    // 旋正后 800×1200 ⇒ 框约 640×240,长宽比约 2.67(未裁时是 0.67)
    expect((m.width ?? 0) / (m.height ?? 1)).toBeGreaterThan(2);
  });

  it('裁切在 .rotate() 之后:同一个框在 Orientation=6 与已旋正图上得到同一结果', async () => {
    const c = crop(0.05, 0.05, 0.5, 0.4);
    const rotated = await renderDerivative(await orientationSixJpeg(), 'ai', c);
    // 把 EXIF 旋正烘焙进像素,再喂同一个框 —— 坐标系约定正确的话两者应当一致
    const baked = await sharp(await orientationSixJpeg()).rotate().jpeg({ quality: 95 }).toBuffer();
    const direct = await renderDerivative(baked, 'ai', c);
    const a = await sharp(rotated).metadata();
    const b = await sharp(direct).metadata();
    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);
  });

  it('thumb / preview 忽略裁切 —— 人眼要拿它跟原件比对(ADR-050)', async () => {
    const source = await orientationSixJpeg();
    const c = crop(0.1, 0.1, 0.3, 0.3);
    for (const variant of ['thumb', 'preview'] as const) {
      expect((await renderDerivative(source, variant, c))
        .equals(await renderDerivative(source, variant))).toBe(true);
    }
  });

  it('退化的框退回整幅,而不是产出几十像素的废图', async () => {
    const source = await orientationSixJpeg();
    const tiny = crop(0.5, 0.5, 0.001, 0.001);          // 旋正后 <1px
    expect((await renderDerivative(source, 'ai', tiny))
      .equals(await renderDerivative(source, 'ai'))).toBe(true);
  });

  it('框整体在图外时被夹回边界,不抛错', async () => {
    const source = await orientationSixJpeg();
    const out = await renderDerivative(source, 'ai', crop(0.9, 0.9, 0.1, 0.1));
    expect((await sharp(out).metadata()).format).toBe('webp');
  });

  it('DERIVATIVE_SPEC 只对 ai 开启裁切', () => {
    expect(DERIVATIVE_SPEC.ai.cropToQuad).toBe(true);
    expect(DERIVATIVE_SPEC.thumb.cropToQuad).toBe(false);
    expect(DERIVATIVE_SPEC.preview.cropToQuad).toBe(false);
  });
});
