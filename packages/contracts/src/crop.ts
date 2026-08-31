import { z } from 'zod';

/**
 * 页面裁切角点(P5-01)。**归一化到 [0,1],定义在按 EXIF Orientation 旋正之后的坐标系。**
 *
 * 两条约定不可改,改了会静默裁错(不报错,只表现为提取质量莫名其妙地差 —— ADR-050 的老问题):
 *
 * 1. **坐标系 = 旋正后。** 采集端量尺寸用的是 `imageOrientation: 'none'`(原始未旋正,
 *    与 page-NN.json 一致),而服务端 `renderDerivative` 第一步就是 `.rotate()`。
 *    角点若记在原始坐标系里,Orientation=6 的照片 —— 按 ADR-050 的实测那是常态 ——
 *    裁切框会整体转 90°,裁出来是一条边。人在 UI 上看到的是旋正后的图,所见即所存。
 * 2. **顺序 = 左上、右上、右下、左下(顺时针)。**
 *
 * 用归一化而非像素:检测跑在降采样图上、裁切作用于全分辨率原件、渲染又在派生物尺寸上,
 * 三个分辨率各不相同。归一化让它们彻底解耦,任何一环改了都不用迁移已存的角点。
 */
export const CropPoint = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .strict();

export const CropQuad = z.tuple([CropPoint, CropPoint, CropPoint, CropPoint]);

export const PageCrop = z
  .object({
    quad: CropQuad,
    /**
     * `auto` = 检测器提议、人未改动;`human` = 人拖过角点。
     * 两者都会被应用,区别只在证据强度 —— 识别质量回归时按它分组,
     * 才能回答"失败是不是集中在没人看过的 auto 裁切上"。
     */
    source: z.enum(['auto', 'human']),
  })
  .strict();

export type CropPointT = z.infer<typeof CropPoint>;
export type CropQuadT = z.infer<typeof CropQuad>;
export type PageCropT = z.infer<typeof PageCrop>;

/** 角点 → 轴对齐包围盒(归一化)。P5 只做轴对齐裁切,不做透视矫正(sharp 无投影变换)。 */
export function quadBounds(quad: CropQuadT): { x: number; y: number; w: number; h: number } {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
