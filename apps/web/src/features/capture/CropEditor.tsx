import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CropQuadT } from '@amr/contracts';

// spec p5-01 §UI。**叠加式确认,不是结果式确认。**
//
// 直觉上"把裁完的图给用户看"更让人放心,但它在最要命的那个错误上恰好失效:
// 框切掉表头(姓名 + 采集时间)之后,裁完的图里那部分根本不存在,用户没有参照物,
// 不会注意到"上面少了一截"—— 你看不见不存在的东西。
// 而在叠加图上,同一个错误就是"框线压在字上",一眼可见。
//
// 所以框外区域**压暗但仍然可见**:被排除的表头就在那儿,暗着,但看得见它被排除了。
// 这个压暗是让破坏性错误可见的机制,不是视觉装饰。

const HANDLE_PX = 44;          // 最小触控目标
const LOUPE_PX = 96;
const LOUPE_ZOOM = 2.5;

interface Props {
  imageUrl: string;
  quad: CropQuadT;
  onChange: (quad: CropQuadT) => void;
}

const CORNER_LABEL = ['左上', '右上', '右下', '左下'] as const;

export function CropEditor({ imageUrl, quad, onChange }: Props): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  // ★ 叠加层按**图片实际渲染框**定位,不能靠 CSS 让容器去贴合图片。
  //   2026-08-31 真机验证:用 inline-block 容器 + absolute inset-0 时,容器高度被
  //   max-h-full 夹住而图片溢出,叠加层比图片矮了 602 px —— 框在屏幕上与照片错位,
  //   而这不会报错。object-contain 的信箱留白也只有实测才拿得准。
  const [box, setBox] = useState<{ left: number; top: number; w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const img = imgRef.current;
      const wrap = wrapRef.current;
      if (!img || !wrap || img.naturalWidth === 0) return;
      const ib = img.getBoundingClientRect();
      const wb = wrap.getBoundingClientRect();
      setBox({ left: ib.left - wb.left, top: ib.top - wb.top, w: ib.width, h: ib.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (imgRef.current) ro.observe(imgRef.current);
    if (wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [imageUrl]);

  const pointToNorm = useCallback((clientX: number, clientY: number) => {
    const img = imgRef.current?.getBoundingClientRect();
    if (!img || img.width === 0 || img.height === 0) return null;
    return {
      x: Math.min(Math.max((clientX - img.left) / img.width, 0), 1),
      y: Math.min(Math.max((clientY - img.top) / img.height, 0), 1),
    };
  }, []);

  const moveCorner = useCallback((index: number, clientX: number, clientY: number) => {
    const p = pointToNorm(clientX, clientY);
    if (!p) return;
    const next = quad.map((old, i) => (i === index ? p : old)) as CropQuadT;
    onChange(next);
  }, [quad, onChange, pointToNorm]);

  const active = dragging === null ? null : quad[dragging];

  // 框外压暗:整幅矩形 + 四边形,evenodd ⇒ 只有四边形之外被填充
  const dimPath =
    `M0,0 H1 V1 H0 Z ` +
    `M${quad[0].x},${quad[0].y} L${quad[1].x},${quad[1].y} ` +
    `L${quad[2].x},${quad[2].y} L${quad[3].x},${quad[3].y} Z`;

  // 叠加层与手柄都挂在这一层上,尺寸 = 图片实测框
  const layer: React.CSSProperties = box
    ? { position: 'absolute', left: box.left, top: box.top, width: box.w, height: box.h }
    : { display: 'none' };

  return (
    <div ref={wrapRef} className="relative w-full h-full flex items-center justify-center leading-none">
      <img
        ref={imgRef}
        src={imageUrl}
        alt="调整识别范围"
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget;
          const wrap = wrapRef.current;
          if (!wrap) return;
          const ib = img.getBoundingClientRect();
          const wb = wrap.getBoundingClientRect();
          setBox({ left: ib.left - wb.left, top: ib.top - wb.top, w: ib.width, h: ib.height });
        }}
        className="block max-w-full max-h-full object-contain select-none rounded-lg"
      />

      <div style={layer} className="pointer-events-none">
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        className="absolute inset-0 w-full h-full pointer-events-none rounded-lg"
        aria-hidden
      >
        <path d={dimPath} fillRule="evenodd" fill="rgb(2 6 23 / 0.62)" />
        <polygon
          points={quad.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke="rgb(45 212 191)"
          strokeWidth={0.006}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {quad.map((p, i) => (
        <button
          key={CORNER_LABEL[i]}
          type="button"
          aria-label={`拖动${CORNER_LABEL[i]}角`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(i);
          }}
          onPointerMove={(e) => { if (dragging === i) moveCorner(i, e.clientX, e.clientY); }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            setDragging(null);
          }}
          onPointerCancel={() => setDragging(null)}
          className="absolute touch-none cursor-grab active:cursor-grabbing pointer-events-auto"
          style={{
            left: `${p.x * 100}%`, top: `${p.y * 100}%`,
            width: HANDLE_PX, height: HANDLE_PX, transform: 'translate(-50%, -50%)',
          }}
        >
          <span className="block w-full h-full rounded-full border-2 border-teal-300/70 bg-teal-400/15" />
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-teal-300 shadow" />
        </button>
      ))}

      {/* 放大镜:手指正好盖住要对准的那个角,没有它就是盲拖 */}
      {active && (
        <div
          className="absolute pointer-events-none rounded-full border-2 border-teal-300/80 shadow-2xl overflow-hidden bg-slate-900"
          style={{
            width: LOUPE_PX, height: LOUPE_PX,
            left: `${active.x * 100}%`,
            top: `${active.y * 100}%`,
            // 放在指尖上方,避免被手挡住;贴近顶边时翻到下方
            transform: active.y < 0.25
              ? 'translate(-50%, 24px)'
              : `translate(-50%, calc(-100% - 24px))`,
            backgroundImage: `url(${imageUrl})`,
            backgroundRepeat: 'no-repeat',
            backgroundSize: `${LOUPE_ZOOM * 100}% ${LOUPE_ZOOM * 100}%`,
            backgroundPosition: `${active.x * 100}% ${active.y * 100}%`,
          }}
        >
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full border border-teal-300" />
        </div>
      )}
      </div>
    </div>
  );
}
