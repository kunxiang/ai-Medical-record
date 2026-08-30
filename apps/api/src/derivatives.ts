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
  // ai:送进模型的输入。**这个数字跟着实际供应商走,不是越大越好。**
  //
  // 2026-08-30 对生产在用的 deepseek-v4-flash-vision-exp 实测(同一份化验单,800/1024/2576
  // 各跑多轮):三档的 input_tokens 恒为 2002 —— 该模型把每张图归一到固定的 384 图像 token,
  // 长边 2576 那张 903 KiB 的图一个 token 都没多买。而它反过来伤了两处:
  //   · 可靠性:2576 档 1/4 成功,失败几乎都是供应商跨境回拉 903 KiB 图超时;1024 档 3/4 成功。
  //   · 准确度:2576 唯一一次成功把患者姓名读成"肖坤"(应为"向坤")—— 姓名要喂给归人对账,
  //     错读会直接产出假的 person_check mismatch。让 sharp 用 Lanczos 缩到接近模型原生尺寸,
  //     比把大图丢给供应商自己压要好。
  // 1024(768×1024 ≈ 79 万像素)贴近该模型约 800×800 的目标像素量,留一点余量给小字。
  // 换供应商时重测这一档,不要沿用。
  ai: { maxEdge: 1024, quality: 92 },
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
