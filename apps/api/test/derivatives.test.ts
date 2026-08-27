// m2-99 A1/B11:送入模型的 ai 派生图必须旋正、去元数据且可确定性重建。
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

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
