import { useCallback, useEffect, useState } from 'react';
import {
  Camera, CheckCircle2, Eye, FileText, Images, Loader2,
  Plus, RotateCcw, RotateCw, Trash2, UploadCloud, Sparkles,
  ArrowRight,
} from 'lucide-react';
import type { BlobRecord } from '../../offline/db.js';
import { blobsOf } from '../../offline/db.js';
import { rotateDraftPage, deleteDraftPage } from '../../offline/capture.js';
import { Button } from '../../ui/Button.js';
import { DraftPreviewModal } from './DraftPreviewModal.js';
import { Card } from '../../ui/Card.js';
import { cn } from '../../ui/cn.js';

interface PageItem {
  record: BlobRecord;
  url: string | null;
}

export function DraftGallery({
  draftId,
  pageCount,
  onDraftChanged,
  onFinish,
  onAddCamera,
  onAddAlbum,
}: {
  draftId: string;
  pageCount: number;
  onDraftChanged: () => Promise<void>;
  onFinish: () => Promise<void>;
  onAddCamera: () => void;
  onAddAlbum: () => void;
}): JSX.Element | null {
  const [items, setItems] = useState<PageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [finishing, setFinishing] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [busyPage, setBusyPage] = useState<number | null>(null);

  const loadBlobs = useCallback(async () => {
    setLoading(true);
    try {
      const records = await blobsOf(draftId, pageCount);
      const newItems: PageItem[] = records.map((r) => {
        let url: string | null = null;
        if (r.mime_type !== 'application/pdf') {
          url = URL.createObjectURL(r.blob);
        }
        return { record: r, url };
      });
      setItems((prev) => {
        for (const it of prev) {
          if (it.url) URL.revokeObjectURL(it.url);
        }
        return newItems;
      });
    } finally {
      setLoading(false);
    }
  }, [draftId, pageCount]);

  useEffect(() => {
    void loadBlobs();
    return () => {
      setItems((prev) => {
        for (const it of prev) {
          if (it.url) URL.revokeObjectURL(it.url);
        }
        return [];
      });
    };
  }, [loadBlobs]);

  async function handleRotate(pageNo: number, deg: 90 | -90) {
    if (busyPage !== null) return;
    setBusyPage(pageNo);
    try {
      await rotateDraftPage(draftId, pageNo, deg);
      await loadBlobs();
      await onDraftChanged();
    } finally {
      setBusyPage(null);
    }
  }

  async function handleDelete(pageNo: number) {
    if (busyPage !== null) return;
    setBusyPage(pageNo);
    try {
      const remaining = await deleteDraftPage(draftId, pageNo);
      if (!remaining || remaining.page_count === 0) {
        setPreviewIndex(null);
        setItems([]);
      } else {
        await loadBlobs();
      }
      await onDraftChanged();
    } finally {
      setBusyPage(null);
    }
  }

  async function handleFinish() {
    if (finishing) return;
    setFinishing(true);
    try {
      await onFinish();
    } finally {
      setFinishing(false);
    }
  }

  if (pageCount === 0 || items.length === 0) return null;

  return (
    <Card className="space-y-6 border-2 border-emerald-500/80 bg-gradient-to-b from-emerald-50/60 via-white to-white shadow-xl shadow-emerald-500/10 animate-in fade-in duration-200">
      {/* Workspace Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-emerald-200/80">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-md shadow-emerald-700/30">
            <Sparkles size={24} className="animate-pulse" />
          </div>
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-emerald-600 text-white shadow-2xs">
                草稿就绪 · {items.length} 页
              </span>
              <span className="text-xs text-emerald-800 font-medium">已安全保存在本地</span>
            </div>
            <h2 className="text-lg sm:text-xl font-extrabold text-slate-900 leading-tight">
              医疗记录已采集，可继续加页或立即上传
            </h2>
          </div>
        </div>

        {/* Primary Finish CTA */}
        <Button
          variant="primary"
          size="lg"
          disabled={finishing || loading || busyPage !== null}
          loading={finishing}
          onClick={() => void handleFinish()}
          data-testid="btn-finish"
          iconLeft={!finishing ? <UploadCloud size={20} className="animate-bounce" /> : undefined}
          className={cn(
            'self-stretch sm:self-auto text-base font-extrabold py-3 px-6 rounded-2xl shadow-xl transition-all cursor-pointer transform hover:-translate-y-0.5 active:translate-y-0',
            'bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-700 hover:from-emerald-500 hover:to-teal-600 text-white shadow-emerald-600/30 border-0',
          )}
        >
          立即完成并上传 ({items.length} 页)
        </Button>
      </div>

      {/* Prominent Large Add-Pages Controls */}
      <div className="space-y-2">
        <span className="text-xs font-bold text-slate-700 uppercase tracking-wider block">
          向当前记录添加更多页面
        </span>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Button
            variant="secondary"
            size="md"
            onClick={onAddCamera}
            data-testid="btn-camera"
            iconLeft={<Camera size={18} className="text-emerald-700" />}
            className="w-full justify-center text-sm sm:text-base font-bold py-3 bg-white hover:bg-emerald-50/70 text-slate-800 border-emerald-200 shadow-sm"
          >
            继续拍照加页
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={onAddAlbum}
            data-testid="btn-album"
            iconLeft={<Images size={18} className="text-emerald-700" />}
            className="w-full justify-center text-sm sm:text-base font-bold py-3 bg-white hover:bg-emerald-50/70 text-slate-800 border-emerald-200 shadow-sm"
          >
            从相册 / PDF 加选文件
          </Button>
        </div>
      </div>

      {/* Thumbnail Preview & Direct Rotation Grid */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
            单页预览与角度调整（点击可大图缩放）
          </span>
          <span className="text-xs text-slate-500">共 {items.length} 页</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 sm:gap-4">
          {items.map((item, idx) => {
            const isBusy = busyPage === item.record.page_no;
            return (
              <div
                key={`${item.record.page_no}-${item.record.sha256}`}
                className="group relative flex flex-col bg-white rounded-2xl border border-emerald-200/90 shadow-sm hover:shadow-md transition-all overflow-hidden"
              >
                {/* Thumbnail stage */}
                <div
                  onClick={() => setPreviewIndex(idx)}
                  className="relative aspect-[3/4] bg-slate-900/5 cursor-pointer overflow-hidden flex items-center justify-center"
                >
                  {item.record.mime_type === 'application/pdf' ? (
                    <div className="flex flex-col items-center justify-center p-3 text-center text-slate-500">
                      <FileText size={36} className="text-brand-500 mb-1" />
                      <span className="text-[11px] font-semibold truncate max-w-[90%]">
                        {item.record.filename}
                      </span>
                    </div>
                  ) : item.url ? (
                    <img
                      key={item.record.sha256}
                      src={item.url}
                      alt={`第 ${item.record.page_no} 页`}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                  ) : (
                    <Loader2 size={24} className="animate-spin text-slate-400" />
                  )}

                  {/* Page badge overlay */}
                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-slate-900/75 backdrop-blur-xs text-white text-[11px] font-bold">
                    第 {item.record.page_no} 页
                  </div>

                  {/* Quick full view hover overlay */}
                  <div className="absolute inset-0 bg-slate-900/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/90 text-slate-900 text-xs font-bold shadow-md">
                      <Eye size={14} /> 查看大图
                    </span>
                  </div>

                  {isBusy && (
                    <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center text-white text-xs font-bold">
                      <Loader2 className="animate-spin mr-1.5" size={16} /> 正在处理…
                    </div>
                  )}
                </div>

                {/* Rotation and delete toolbar under thumbnail */}
                <div className="flex items-center justify-between p-2 bg-slate-50 border-t border-line/60">
                  <div className="flex items-center gap-1">
                    {item.record.mime_type !== 'application/pdf' && (
                      <>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRotate(item.record.page_no, -90);
                          }}
                          title="向左旋转90度"
                          className="p-1.5 rounded-lg text-slate-600 hover:text-emerald-700 hover:bg-emerald-100/70 active:bg-emerald-200 transition-colors cursor-pointer disabled:opacity-40"
                        >
                          <RotateCcw size={15} />
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRotate(item.record.page_no, 90);
                          }}
                          title="向右旋转90度"
                          className="p-1.5 rounded-lg text-slate-600 hover:text-emerald-700 hover:bg-emerald-100/70 active:bg-emerald-200 transition-colors cursor-pointer disabled:opacity-40"
                        >
                          <RotateCw size={15} />
                        </button>
                      </>
                    )}
                  </div>

                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(item.record.page_no);
                    }}
                    title="删除此页"
                    className="p-1.5 rounded-lg text-rose-500 hover:text-rose-700 hover:bg-rose-100/70 active:bg-rose-200 transition-colors cursor-pointer disabled:opacity-40"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Fullscreen Draft Preview & Rotation Modal */}
      {previewIndex !== null && previewIndex < items.length && (
        <DraftPreviewModal
          open={previewIndex !== null}
          blobs={items.map((it) => it.record)}
          initialIndex={previewIndex}
          onClose={() => setPreviewIndex(null)}
          onRotate={handleRotate}
          onDelete={handleDelete}
          onFinish={handleFinish}
          finishing={finishing}
        />
      )}
    </Card>
  );
}
