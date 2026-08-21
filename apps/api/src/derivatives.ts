import sharp from 'sharp';
import { buildKey } from '@amr/storage';
import { ApiError } from './errors.js';
import { getObjectBytes, headObject, putDerivative } from './s3.js';

// spec m1-03 §2:确定性参数。sharp.concurrency 是进程级全局 → 启动时设一次(审核 #002 B 档)。
export function initSharp(): void {
  sharp.concurrency(1);
  sharp.cache(false);
}

// 质量分档的理由(ADR-050):thumb/preview 的消费者是人眼,ai 的消费者是 OCR。
// 官方明确警告有损压缩会让小字难以辨认,而化验单的小数点与 10⁹/L 上标恰恰吃这个。
export const DERIVATIVE_SPEC = {
  thumb: { maxEdge: 400, quality: 82 },
  preview: { maxEdge: 1600, quality: 82 },
  // ai:送进模型的输入。2576 是 Opus 5 高分辨率档的长边上限,超过只会被服务端downscale。
  ai: { maxEdge: 2576, quality: 92 },
} as const;

export type Variant = keyof typeof DERIVATIVE_SPEC;

const GEN_TIMEOUT_MS = 10_000;

/** 从原件字节生成派生物。纯函数(除 sharp),便于 B3 确定性断言直接调用。 */
export async function renderDerivative(source: Buffer, variant: Variant): Promise<Buffer> {
  const { maxEdge, quality } = DERIVATIVE_SPEC[variant];
  return sharp(source, { failOn: 'error' })
    // ★ .rotate() 是 ai 变体存在的全部理由(ADR-050):Claude 不解析图片元数据,
    //   原件的 EXIF Orientation 会被完全忽略 —— 不旋正就是把横躺的单据送进模型,
    //   而且不会报错,只表现为"提取质量莫名其妙地差"。
    .rotate()                                   // 按 EXIF Orientation 旋正(原件不动,只影响派生物)
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 4 })
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
