import sharp from 'sharp';
import { buildKey } from '@amr/storage';
import { quadBounds, type PageCropT } from '@amr/contracts';
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
  //
  // cropToQuad:只有 ai 吃人工确认的裁切框。thumb/preview 的消费者是人眼 ——
  // 复核时人要拿它跟原件比对(ADR-050),裁过的预览会让人核对的是被处理过的东西。
  thumb: { maxEdge: 400, quality: 82, cropToQuad: false },
  preview: { maxEdge: 1600, quality: 82, cropToQuad: false },
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
  ai: { maxEdge: 1024, quality: 92, cropToQuad: true },
} as const;

export type Variant = keyof typeof DERIVATIVE_SPEC;

const GEN_TIMEOUT_MS = 10_000;

/** 裁切框的绝对下限(旋正后像素)。低于此值视为检测退化,退回整幅。 */
const MIN_CROP_EDGE_PX = 64;

/** 旋正后的像素尺寸。`.rotate()` 按 EXIF Orientation 旋正,5–8 会交换宽高。
 *  裁切框定义在旋正后的坐标系里(见 contracts/crop.ts),故必须用这个尺寸换算。 */
async function rotatedSize(source: Buffer): Promise<{ width: number; height: number }> {
  const m = await sharp(source).metadata();
  const width = m.width ?? 0;
  const height = m.height ?? 0;
  const swaps = typeof m.orientation === 'number' && m.orientation >= 5 && m.orientation <= 8;
  return swaps ? { width: height, height: width } : { width, height };
}

/** 归一化角点 → sharp.extract 的整数像素框。不可用则返回 null(⇒ 退回整幅)。 */
async function extractBox(
  source: Buffer, crop: PageCropT,
): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const { width: W, height: H } = await rotatedSize(source);
  if (W < 1 || H < 1) return null;

  const b = quadBounds(crop.quad);
  const left = Math.min(Math.max(Math.round(b.x * W), 0), W - 1);
  const top = Math.min(Math.max(Math.round(b.y * H), 0), H - 1);
  const width = Math.min(Math.max(Math.round(b.w * W), 1), W - left);
  const height = Math.min(Math.max(Math.round(b.h * H), 1), H - top);

  // 服务端不盲信客户端的框。采集端的可信闸门已经拦过一道,这里是纵深防御:
  // 退化的框(几十像素)只会把提取质量打穿,而退回整幅是已知可用的行为(2026-08-30 实测 6/6)。
  // 跳过而不是抛错 —— 裁边是增益不是前提,任何时候都不该让它变成上传/识别的阻塞点。
  if (width < MIN_CROP_EDGE_PX || height < MIN_CROP_EDGE_PX) return null;
  return { left, top, width, height };
}

/** 从原件字节生成派生物。确定性函数(除 sharp),便于 B3 确定性断言直接调用。
 *  `crop` 只对 `cropToQuad` 的变体生效;为 null 时行为与加裁切之前逐字节一致。 */
export async function renderDerivative(
  source: Buffer, variant: Variant, crop: PageCropT | null = null,
): Promise<Buffer> {
  const { maxEdge, quality, cropToQuad } = DERIVATIVE_SPEC[variant];

  let pipeline = sharp(source, { failOn: 'error' })
    // ★ .rotate() 是 ai 变体存在的全部理由(ADR-050):Claude 不解析图片元数据,
    //   原件的 EXIF Orientation 会被完全忽略 —— 不旋正就是把横躺的单据送进模型,
    //   而且不会报错,只表现为"提取质量莫名其妙地差"。
    .rotate();                                  // 按 EXIF Orientation 旋正(原件不动,只影响派生物)

  if (cropToQuad && crop) {
    // ★ 顺序不可换:裁切必须在 .rotate() 之后(角点定义在旋正后坐标系)、
    //   .resize() 之前(要在全分辨率上裁,裁完再缩才买得到"每字符像素数")。
    //   放到 resize 之后等于白做 —— 该模型把每张图归一到固定 384 图像 token,
    //   像素预算是死的,裁掉背景是唯一还能提高每字符像素数的杠杆。
    const box = await extractBox(source, crop);
    if (box) pipeline = pipeline.extract(box);
  }

  return pipeline
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
  /** 人工确认的裁切角点(来自 document_page.crop_quad,源头是 WORM 的 capture.json)。 */
  crop?: PageCropT | null;
}): Promise<{ key: string; generated: boolean }> {
  if (args.mimeType === 'application/pdf') {
    // M1 不渲染 PDF(设计债 D13)
    throw new ApiError('derivative_unavailable', 'PDF 页暂不支持缩略图');
  }
  const key = buildKey.derivative({
    personSlug: args.personSlug, docShortId: args.docShortId,
    variant: args.variant, pageNo: args.pageNo,
  });
  // ★ key 不编码 crop。这只在 crop 于上传瞬间即冻结(capture.json 是 WORM)时才安全。
  //   将来若开放事后改裁切(correction-NNNN.json 追加 crop_adjust),这里就成了陈旧缓存,
  //   必须改为删除既有派生物或把 crop 摘要并入 key。
  if (await headObject(key)) return { key, generated: false };

  const source = await getObjectBytes(args.sourceKey);
  if (!source) throw new ApiError('derivative_generation_failed', '原件不可读');

  let out: Buffer;
  try {
    // 软超时:提前释放请求;sharp 不可取消,工作线程仍会跑完(spec m1-03 §3)
    out = await Promise.race([
      renderDerivative(source, args.variant, args.crop ?? null),
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
