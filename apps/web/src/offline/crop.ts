import { quadBounds, type CropQuadT, type CropPointT, type PageCropT } from '@amr/contracts';

// spec p5-01。裁边只为一件事:提高送进模型那张图的**每字符像素数**。
//
// 2026-08-30 实测:生产在用的 deepseek-v4-flash-vision-exp 把每张图归一到固定 384 图像 token,
// 长边 800/1024/2576 的 input_tokens 恒为 2002 —— 尺寸买不到更多像素,像素预算是死的。
// 于是画面里给桌面和背景的每一个像素,都是从单据文字身上抢走的。裁掉背景是唯一还剩的杠杆,
// 而且顺带缩小供应商跨境回拉的体积(那正是当时超时失败的变量)。
//
// ★ 全部坐标归一化到 [0,1],定义在**按 EXIF Orientation 旋正之后**的坐标系里,
//   与服务端 renderDerivative 的 .rotate() 一致。详见 contracts/crop.ts 的约定说明。

/** 检测用的降采样边长。四边形检测对分辨率不敏感,降采样把每页耗时从数百毫秒压到几十毫秒。 */
const DETECT_MAX_EDGE = 800;

/**
 * 可信闸门。检测不可信时**不画框(等于不裁)**,而不是画一个烂框让用户去修 ——
 * 不裁的后果只是回到已知可用的行为(2026-08-30 实测 6/6 全过),裁坏的后果是
 * 表头连同姓名和采集时间被永久排除在模型视野外,产出假的 person_check mismatch。
 */
const MIN_AREA_FRACTION = 0.25;
const MAX_AREA_FRACTION = 0.92;
/** 四角都贴着画面边缘 ⇒ 检测器其实什么也没找到,把整幅当成了纸。 */
const EDGE_HUG_TOLERANCE = 0.02;
const MIN_ASPECT = 0.25;
const MAX_ASPECT = 4;

export type { CropQuadT, PageCropT };

// ── OpenCV / jscanify 惰性加载 ────────────────────────────────────────────────
// 体积可观(opencv.js gzip 约 3.6 MB),所以动态 import;但**必须进 precache** ——
// 采集是离线优先的,懒加载而不缓存会让裁边正好废在信号差的诊室里。
// 见 vite.config.ts 的 maximumFileSizeToCacheInBytes(默认 2 MiB 会把它静默踢出 precache)。

interface Scanner {
  findPaperContour(img: unknown): unknown;
  getCornerPoints(contour: unknown): {
    topLeftCorner?: { x: number; y: number };
    topRightCorner?: { x: number; y: number };
    bottomRightCorner?: { x: number; y: number };
    bottomLeftCorner?: { x: number; y: number };
  };
}

let scannerPromise: Promise<Scanner | null> | null = null;

async function loadScanner(): Promise<Scanner | null> {
  scannerPromise ??= (async () => {
    try {
      const [cvModule, jscanifyModule] = await Promise.all([
        import('@techstark/opencv-js'),
        import('../vendor/jscanify.js'),
      ]);
      // ★ @techstark/opencv-js@5 的 default 是个 **thenable**:await 它才拿到就绪的 cv。
      //   不要退回旧版的 `cv.onRuntimeInitialized = …` 写法 —— v5 永远不会调用它,
      //   表现为等待超时后静默退回不裁(2026-08-31 真机验证时就是栽在这里)。
      //   await 一个非 thenable 是空操作,所以这行对两种形态都成立。
      const cv = await withTimeout(
        Promise.resolve((cvModule as { default?: unknown }).default ?? cvModule),
        CV_INIT_TIMEOUT_MS,
      ) as { Mat?: unknown };
      if (typeof cv.Mat !== 'function') throw new Error('opencv 运行时未就绪');
      // jscanify 从全局 cv 取 API,故必须在实例化之前注入
      (globalThis as unknown as { cv: unknown }).cv = cv;
      return new jscanifyModule.default() as unknown as Scanner;
    } catch (e) {
      // 加载失败(离线冷启动、被拦截、供应商换了初始化契约)不是错误路径 ——
      // 退回不裁,采集流程照常。但**必须留下原因**:行为上静默是对的,诊断上静默不是。
      // 2026-08-31 的真机验证就是败在这里 —— 检测全程返回 null 而控制台一片干净。
      console.warn('[crop] 检测器不可用,本次不裁边:', e);
      return null;
    }
  })();
  return scannerPromise;
}

/** wasm 就绪的兜底上限。卡住时退回不裁,绝不让采集流程挂在这里。 */
const CV_INIT_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('opencv 运行时初始化超时')), ms)),
  ]);
}

// ── 几何 ────────────────────────────────────────────────────────────────────

/** 四边形面积(鞋带公式,归一化坐标 ⇒ 结果即占画面的比例)。 */
function quadArea(quad: CropQuadT): number {
  let sum = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** 凸性:四个叉积同号。自交或凹的四边形一律判为检测失败。 */
function isConvex(quad: CropQuadT): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const c = quad[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return sign !== 0;
}

/**
 * 可信闸门。**已知拦不住的一类:对折过的单据。**
 * A4 对折后铺平,中间折痕是一条很强的直边,findPaperContour 可能只框住半页;
 * 而半页的面积占比(约 40–50%)和长宽比都还在"合理"区间里,三道闸门全都拦不住,
 * 缩略图上也看不出来 —— 半页化验单看起来就像一张完整的化验单。
 * 这是接受"裁边是增益不是保证"的代价,靠人工在预览里发现。P5 的第一批人工调整
 * 数据要专门统计有折痕单据的改框比例,再决定是否需要给靠近画面中线的强直边降权。
 */
export function isPlausibleQuad(quad: CropQuadT): boolean {
  if (quad.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  if (quad.some((p) => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return false;
  if (!isConvex(quad)) return false;

  const area = quadArea(quad);
  if (area < MIN_AREA_FRACTION || area > MAX_AREA_FRACTION) return false;

  const b = quadBounds(quad);
  if (b.w <= 0 || b.h <= 0) return false;
  const aspect = b.w / b.h;
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) return false;

  // 四角贴边 ⇒ 没检测到东西
  const hugs = quad.every((p) =>
    (p.x <= EDGE_HUG_TOLERANCE || p.x >= 1 - EDGE_HUG_TOLERANCE) &&
    (p.y <= EDGE_HUG_TOLERANCE || p.y >= 1 - EDGE_HUG_TOLERANCE));
  return !hugs;
}

/**
 * 把角点跟着图像旋转一起变换。
 *
 * ★ 少了这一步就是一个必然发生的静默 bug:rotateDraftPage 会重写 blob,
 *   已存的 quad 还留在旧坐标系里 —— 转 90° 之后框要么跑到画面外,要么框住一条边,
 *   而且不报错。数组顺序也必须跟着转,否则"左上"指向的不再是左上角。
 */
export function rotateQuad(quad: CropQuadT, degrees: number): CropQuadT {
  const deg = ((degrees % 360) + 360) % 360;
  if (deg === 0) return quad;

  const map: Record<number, (p: CropPointT) => CropPointT> = {
    90: (p) => ({ x: 1 - p.y, y: p.x }),      // 顺时针:左上 → 右上
    180: (p) => ({ x: 1 - p.x, y: 1 - p.y }),
    270: (p) => ({ x: p.y, y: 1 - p.x }),     // 逆时针:左上 → 左下
  };
  const shift: Record<number, number> = { 90: 3, 180: 2, 270: 1 };
  const f = map[deg];
  const k = shift[deg];
  if (!f || k === undefined) return quad;

  // 先按旋转重排"哪个角现在是左上",再逐点做坐标变换
  const reordered = [quad[k % 4]!, quad[(k + 1) % 4]!, quad[(k + 2) % 4]!, quad[(k + 3) % 4]!];
  return [f(reordered[0]!), f(reordered[1]!), f(reordered[2]!), f(reordered[3]!)];
}

/** 整幅的角点,给"重置/手动起步"用。 */
export function fullFrameQuad(): CropQuadT {
  return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
}

// ── 检测 ────────────────────────────────────────────────────────────────────

/** 串行化:连拍时十几页同时排队会把主线程打满,而用户还在按快门。 */
let detectChain: Promise<unknown> = Promise.resolve();

/**
 * 自动检测单据边界。返回 null 表示"没检测到 / 不可信" ⇒ 不裁。
 * **绝不抛错、绝不阻塞采集** —— 裁边是增益,不是上传的前提。
 */
export async function detectCrop(blob: Blob): Promise<PageCropT | null> {
  const run = detectChain.then(() => detectOnce(blob).catch(() => null));
  detectChain = run.catch(() => null);
  return run;
}

/**
 * 等待当前排队的检测全部落定(带上限)。
 * 用在"点上传"那一刻:检测是异步的而用户不会等 —— 拍一张、返回、立刻再拍,
 * 等他按下上传时后几页可能还在队列里。不等就会出现**同一份文档有的页裁了有的页没裁**,
 * 正确性上不算错(每页独立提取),但模型输入质量在页间不一致,用户眼里则是"时灵时不灵"。
 * 降采样之后每页只要几十毫秒,等待通常无感;超时就放弃,绝不阻塞上传。
 */
export async function whenDetectionSettles(timeoutMs = 4000): Promise<void> {
  await Promise.race([
    detectChain.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function detectOnce(blob: Blob): Promise<PageCropT | null> {
  if (!blob.type.startsWith('image/')) return null;      // PDF 没有"单据边界"这回事
  const scanner = await loadScanner();
  if (!scanner) return null;

  // ★ imageOrientation:'from-image' —— 检测必须跑在**旋正后**的光栅上,
  //   这样得到的归一化角点才与服务端 .rotate() 之后的坐标系对得上。
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, DETECT_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);

    const cv = (globalThis as unknown as { cv: { imread(c: HTMLCanvasElement): { delete(): void } } }).cv;
    const mat = cv.imread(canvas);
    try {
      const contour = scanner.findPaperContour(mat);
      if (!contour) return null;
      const c = scanner.getCornerPoints(contour);
      const tl = c.topLeftCorner, tr = c.topRightCorner;
      const br = c.bottomRightCorner, bl = c.bottomLeftCorner;
      if (!tl || !tr || !br || !bl) return null;

      const quad: CropQuadT = [
        { x: tl.x / w, y: tl.y / h },
        { x: tr.x / w, y: tr.y / h },
        { x: br.x / w, y: br.y / h },
        { x: bl.x / w, y: bl.y / h },
      ];
      const clamped = quad.map((p) => ({
        x: Math.min(Math.max(p.x, 0), 1),
        y: Math.min(Math.max(p.y, 0), 1),
      })) as CropQuadT;
      return isPlausibleQuad(clamped) ? { quad: clamped, source: 'auto' } : null;
    } finally {
      mat.delete();
    }
  } finally {
    bitmap.close();
  }
}
