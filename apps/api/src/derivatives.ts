import sharp from 'sharp';
import { buildKey } from '@amr/storage';
import { ApiError } from './errors.js';
import { getObjectBytes, headObject, putDerivative } from './s3.js';

// spec m1-03 §2:确定性参数。sharp.concurrency 是进程级全局 → 启动时设一次(审核 #002 B 档)。
export function initSharp(): void {
  sharp.concurrency(1);
  sharp.cache(false);
}

export const DERIVATIVE_SPEC = {
  thumb: { maxEdge: 400 },
  preview: { maxEdge: 1600 },
} as const;

export type Variant = keyof typeof DERIVATIVE_SPEC;

const GEN_TIMEOUT_MS = 10_000;

/** 从原件字节生成派生物。纯函数(除 sharp),便于 B3 确定性断言直接调用。 */
export async function renderDerivative(source: Buffer, variant: Variant): Promise<Buffer> {
  const { maxEdge } = DERIVATIVE_SPEC[variant];
  return sharp(source, { failOn: 'error' })
    .rotate()                                   // 按 EXIF Orientation 旋正(原件不动,只影响派生物)
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();                                // sharp 默认不携带 EXIF/ICC ⇒ 派生物无 GPS(ADR-031)
}

/**
 * 惰性生成(spec m1-03 §3):存在即返回,不存在则同步生成后返回。
 * @returns generated=true 表示本次触发了生成
 */
export async function ensureDerivative(args: {
  personSlug: string; docShortId: string; pageNo: number;
  variant: Variant; sourceKey: string; mimeType: string;
}): Promise<{ key: string; generated: boolean }> {
  if (args.mimeType === 'application/pdf') {
    // M1 不渲染 PDF(设计债 D13)
    throw new ApiError('derivative_unavailable', 'PDF 页暂不支持缩略图');
  }
  const key = buildKey.derivative({
    personSlug: args.personSlug, docShortId: args.docShortId,
    variant: args.variant, pageNo: args.pageNo,
  });
  if (await headObject(key)) return { key, generated: false };

  const source = await getObjectBytes(args.sourceKey);
  if (!source) throw new ApiError('derivative_generation_failed', '原件不可读');

  let out: Buffer;
  try {
    // 软超时:提前释放请求;sharp 不可取消,工作线程仍会跑完(spec m1-03 §3)
    out = await Promise.race([
      renderDerivative(source, args.variant),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), GEN_TIMEOUT_MS)),
    ]);
  } catch (e) {
    throw new ApiError('derivative_generation_failed', '派生物生成失败', {
      source_key: args.sourceKey, cause: e instanceof Error ? e.message : String(e),
    });
  }
  await putDerivative(key, out);   // ★ 不上锁(L2)
  return { key, generated: true };
}
