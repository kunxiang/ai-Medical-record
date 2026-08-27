import { useEffect, useState } from 'react';
import {
  ChevronLeft, ChevronRight, RotateCcw, RotateCw, Trash2,
  X, UploadCloud, FileText, Loader2, Sparkles,
} from 'lucide-react';
import type { BlobRecord } from '../../offline/db.js';
import { Button } from '../../ui/Button.js';
import { IconButton } from '../../ui/IconButton.js';

export function DraftPreviewModal({
  open,
  blobs,
  initialIndex = 0,
  onClose,
  onRotate,
  onDelete,
  onFinish,
  finishing,
}: {
  open: boolean;
  blobs: BlobRecord[];
  initialIndex?: number;
  onClose: () => void;
  onRotate: (pageNo: number, degrees: 90 | -90) => Promise<void>;
  onDelete: (pageNo: number) => Promise<void>;
  onFinish: () => Promise<void>;
  finishing: boolean;
}): JSX.Element | null {
  const [index, setIndex] = useState(initialIndex);
  const [rotating, setRotating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    setIndex(Math.min(initialIndex, Math.max(0, blobs.length - 1)));
  }, [initialIndex, blobs.length]);

  const current = blobs[index];

  useEffect(() => {
    if (!current) {
      setImageUrl(null);
      return;
    }
    if (current.mime_type === 'application/pdf') {
      setImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(current.blob);
    setImageUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [current, current?.blob]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && index > 0) setIndex((i) => i - 1);
      if (e.key === 'ArrowRight' && index < blobs.length - 1) setIndex((i) => i + 1);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, index, blobs.length]);

  if (!open || !current) return null;

  async function handleRotate(deg: 90 | -90) {
    if (rotating || !current) return;
    setRotating(true);
    try {
      await onRotate(current.page_no, deg);
    } finally {
      setRotating(false);
    }
  }

  async function handleDelete() {
    if (deleting || !current) return;
    setDeleting(true);
    try {
      await onDelete(current.page_no);
      if (index >= blobs.length - 1) {
        setIndex(Math.max(0, blobs.length - 2));
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="草稿单页大图预览与旋转"
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200"
    >
      <div className="relative flex flex-col w-full h-full max-w-4xl max-h-[94vh] bg-slate-900 rounded-2xl sm:rounded-3xl border border-slate-700/80 shadow-2xl overflow-hidden text-white">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 sm:px-6 sm:py-4 bg-slate-900/90 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-3">
            <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-brand-500/20 text-brand-300 border border-brand-500/30">
              第 {index + 1} 页 / 共 {blobs.length} 页
            </span>
            <span className="text-xs text-slate-400 hidden sm:inline">
              {current.width} × {current.height} · {(current.byte_size / 1024).toFixed(0)} KB
            </span>
          </div>

          <div className="flex items-center gap-2">
            <IconButton
              aria-label="关闭预览"
              onClick={onClose}
              variant="ghost"
              className="text-slate-300 hover:text-white hover:bg-slate-800"
            >
              <X size={20} />
            </IconButton>
          </div>
        </div>

        {/* Main Stage */}
        <div className="relative flex-1 min-h-0 flex items-center justify-center p-3 sm:p-6 bg-black/40 overflow-hidden select-none">
          {current.mime_type === 'application/pdf' ? (
            <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-slate-400">
              <FileText size={56} className="text-brand-400" />
              <div className="space-y-1">
                <strong className="text-base text-slate-200 block">{current.filename}</strong>
                <span className="text-xs text-slate-400 block">PDF 文档（不支持直接旋转）</span>
              </div>
            </div>
          ) : imageUrl ? (
            <img
              src={imageUrl}
              alt={`第 ${current.page_no} 页预览`}
              className="max-h-full max-w-full object-contain rounded-lg shadow-lg transition-transform duration-200"
            />
          ) : (
            <div className="flex items-center gap-2 text-slate-400">
              <Loader2 className="animate-spin" size={24} />
              <span>加载中…</span>
            </div>
          )}

          {/* Left / Right Page Switchers */}
          {blobs.length > 1 && (
            <>
              <button
                type="button"
                disabled={index === 0}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                aria-label="上一页"
                className="absolute left-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-slate-900/80 hover:bg-slate-800 border border-slate-700/80 flex items-center justify-center text-white disabled:opacity-30 disabled:pointer-events-none transition-all shadow-lg cursor-pointer"
              >
                <ChevronLeft size={24} />
              </button>
              <button
                type="button"
                disabled={index === blobs.length - 1}
                onClick={() => setIndex((i) => Math.min(blobs.length - 1, i + 1))}
                aria-label="下一页"
                className="absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-slate-900/80 hover:bg-slate-800 border border-slate-700/80 flex items-center justify-center text-white disabled:opacity-30 disabled:pointer-events-none transition-all shadow-lg cursor-pointer"
              >
                <ChevronRight size={24} />
              </button>
            </>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4 bg-slate-900 border-t border-slate-800 shrink-0">
          {/* Rotation & Delete Controls */}
          <div className="flex items-center gap-2">
            {current.mime_type !== 'application/pdf' && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={rotating}
                  loading={rotating}
                  onClick={() => void handleRotate(-90)}
                  iconLeft={<RotateCcw size={15} />}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-100 border-slate-700 text-xs sm:text-sm"
                >
                  向左旋转 90°
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={rotating}
                  loading={rotating}
                  onClick={() => void handleRotate(90)}
                  iconLeft={<RotateCw size={15} />}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-100 border-slate-700 text-xs sm:text-sm"
                >
                  向右旋转 90°
                </Button>
              </>
            )}

            <Button
              variant="danger-soft"
              size="sm"
              disabled={deleting}
              loading={deleting}
              onClick={() => void handleDelete()}
              iconLeft={<Trash2 size={15} />}
              className="text-xs sm:text-sm"
            >
              删除本页
            </Button>
          </div>

          {/* Prominent Finish CTA */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="text-slate-300 hover:text-white hover:bg-slate-800 text-xs sm:text-sm"
            >
              继续调整
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={finishing}
              loading={finishing}
              onClick={onFinish}
              iconLeft={<UploadCloud size={17} />}
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold shadow-lg shadow-emerald-900/40 text-xs sm:text-sm px-5"
            >
              完成并立即上传 ({blobs.length} 页)
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
