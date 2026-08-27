import { useRef, useState } from 'react';
import {
  Camera, CheckCircle2, FileStack, Images, LockKeyhole, ShieldCheck,
  Sparkles, UploadCloud,
} from 'lucide-react';
import type { CreatePersonInput } from '../../api/client.js';
import type { Person } from '../../App.js';
import { CaptureRejected, appendDraftPage, finalizeDraft, preparePage, reassignQueued } from '../../offline/capture.js';
import { ensureRoomFor } from '../../offline/persist.js';
import type { CaptureRecord } from '../../offline/db.js';
import { QueuePanel } from './QueuePanel.js';
import { CreatePersonDialog } from './CreatePersonDialog.js';
import { tick } from '../../offline/queue.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { PersonSelector } from '../../ui/PersonSelector.js';
import { Card } from '../../ui/Card.js';
import { Button } from '../../ui/Button.js';
import { Alert } from '../../ui/Alert.js';
import { cn } from '../../ui/cn.js';

export function CaptureView({
  people,
  selected,
  onSelect,
  onCreatePerson,
  queue,
  onQueueChanged,
}: {
  people: Person[];
  selected: Person | null;
  onSelect: (p: Person) => void;
  onCreatePerson: (input: CreatePersonInput) => Promise<Person>;
  queue: CaptureRecord[];
  onQueueChanged: () => Promise<void>;
}): JSX.Element {
  const cameraRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftPages, setDraftPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [creatingPerson, setCreatingPerson] = useState(false);

  const pending = queue.filter((q) => q.state !== 'draft');
  const needsPerson = queue.filter((q) => q.state === 'pending_person');

  async function ingest(files: FileList | null, source: 'camera' | 'album'): Promise<void> {
    if (!files?.length) return;
    setError(null);
    let activeDraftId = draftId ?? undefined;
    try {
      for (const file of Array.from(files)) {
        const room = await ensureRoomFor(file.size);
        if (!room.ok) throw new CaptureRejected(room.reason!);
        const page = await preparePage(file); // 校验 + 物化 Blob + 摘要 + 尺寸 + EXIF
        const rec = await appendDraftPage({
          draftId: activeDraftId,
          person: selected ? { id: selected.id, slug: selected.slug, display_name: selected.display_name } : null,
          page,
          source: page.mime_type === 'application/pdf' ? 'pdf' : source,
        });
        activeDraftId = rec.client_document_id;
        setDraftId(rec.client_document_id);
        setDraftPages(rec.page_count);
      }
      await onQueueChanged();
    } catch (e) {
      setError(e instanceof CaptureRejected ? e.message : `读取失败:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function finish(): Promise<void> {
    if (!draftId) return;
    await finalizeDraft(draftId);
    setDraftId(null);
    setDraftPages(0);
    await onQueueChanged();
    void tick('after-finalize');
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="采集中心"
        title="保存一份医疗记录"
        description="拍照或导入文件，MediReco 会保留原件并自动整理。"
        action={
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/90 text-brand-700 border border-brand-200 shadow-2xs">
            <ShieldCheck size={16} className="text-brand-600" /> 原件零改动
          </span>
        }
      />

      {/* Person Selector */}
      <PersonSelector
        people={people}
        selected={selected}
        onSelect={onSelect}
        onAddPerson={() => setCreatingPerson(true)}
      />

      {!selected && (
        <Alert variant="warning" data-testid="no-person-warning">
          未选择归属人：仍可拍照，但在选人之前不会上传。
        </Alert>
      )}

      {/* Capture Studio */}
      <Card className="space-y-5">
        <div className="flex items-center gap-3 pb-3 border-b border-line/60">
          <div className="w-10 h-10 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
            <Sparkles size={20} />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-bold text-ink leading-snug">
              {draftPages > 0 ? '继续添加这一份记录' : '添加医疗文件'}
            </h2>
            <p className="text-xs text-muted leading-tight">
              {draftPages > 0
                ? `草稿已安全保存 ${draftPages} 页，可以继续拍摄或完成归档。`
                : '支持照片、相册多选和 PDF，单个文件最大 50 MiB。'}
            </p>
          </div>
        </div>

        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            void ingest(e.target.files, 'camera');
            e.target.value = '';
          }}
          data-testid="input-camera"
        />
        <input
          ref={albumRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          hidden
          onChange={(e) => {
            void ingest(e.target.files, 'album');
            e.target.value = '';
          }}
          data-testid="input-album"
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => cameraRef.current?.click()}
            data-testid="btn-camera"
            className={cn(
              'group relative flex items-center justify-between p-5 rounded-2xl border text-left transition-all duration-200 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2',
              'bg-brand-500 hover:bg-brand-600 active:bg-brand-700 text-white border-brand-600/50 shadow-brand',
            )}
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
                <Camera size={26} />
              </div>
              <div className="space-y-0.5">
                <strong className="text-base font-bold block">
                  {draftPages > 0 ? '继续拍照' : '拍照采集'}
                </strong>
                <span className="text-xs text-white/80 block">
                  {draftPages > 0 ? `已保存 ${draftPages} 页` : '适合纸质病历与报告'}
                </span>
              </div>
            </div>
            <span className="text-xl font-bold text-white/70 group-hover:translate-x-1 transition-transform">
              →
            </span>
          </button>

          <button
            type="button"
            onClick={() => albumRef.current?.click()}
            data-testid="btn-album"
            className={cn(
              'group relative flex items-center justify-between p-5 rounded-2xl border text-left transition-all duration-200 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2',
              'bg-white hover:bg-brand-50/40 active:bg-brand-100/50 text-ink border-line hover:border-brand-300 shadow-soft',
            )}
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
                <Images size={25} />
              </div>
              <div className="space-y-0.5">
                <strong className="text-base font-bold block">相册 / PDF</strong>
                <span className="text-xs text-muted block">支持一次选择多个文件</span>
              </div>
            </div>
            <span className="text-xl font-bold text-muted group-hover:text-brand-600 group-hover:translate-x-1 transition-all">
              →
            </span>
          </button>
        </div>

        {draftPages > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-2xl bg-brand-50 border border-brand-200/80 shadow-xs animate-in fade-in duration-200">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-brand-500 text-white flex items-center justify-center shrink-0 shadow-2xs">
                <FileStack size={20} />
              </div>
              <div>
                <strong className="text-sm font-bold text-brand-900 block">
                  当前草稿 · {draftPages} 页
                </strong>
                <span className="text-xs text-brand-700">每一页都已保存在本机</span>
              </div>
            </div>
            <Button
              variant="primary"
              size="md"
              onClick={() => void finish()}
              iconLeft={<CheckCircle2 size={17} />}
              data-testid="btn-finish"
              className="rounded-xl self-stretch sm:self-auto shadow-sm"
            >
              完成这份({draftPages} 页)
            </Button>
          </div>
        )}

        {error && (
          <Alert variant="danger" data-testid="capture-error">
            {error}
          </Alert>
        )}
      </Card>

      {/* Upload Summary Bar */}
      <div
        className={cn(
          'flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl border transition-all duration-200',
          pending.length > 0
            ? 'bg-white/95 border-brand-200 shadow-soft'
            : 'bg-success-bg/40 border-success-border/60 text-success-text shadow-2xs',
        )}
      >
        <div className="flex items-center gap-3.5">
          <div
            className={cn(
              'w-11 h-11 rounded-xl flex items-center justify-center shrink-0',
              pending.length > 0 ? 'bg-brand-50 text-brand-600' : 'bg-success-bg text-success',
            )}
          >
            {pending.length > 0 ? <UploadCloud size={24} /> : <CheckCircle2 size={24} />}
          </div>
          <div className="space-y-0.5">
            <strong className="text-base font-bold text-ink block" data-testid="queue-count">
              {pending.length} 张待上传
            </strong>
            <span
              className="text-xs text-muted block"
              data-testid={pending.length > 0 ? 'queue-hint' : undefined}
            >
              {pending.length > 0 ? '保持应用打开直到上传完成' : '全部已安全上传到档案库'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3 self-start sm:self-auto">
          {needsPerson.length > 0 && (
            <span
              className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-warning-bg text-warning-text border border-warning-border"
              data-testid="needs-person"
            >
              {needsPerson.length} 张待归人，选人后才会上传
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <LockKeyhole size={14} className="text-brand-600" /> 加密传输
          </span>
        </div>
      </div>

      {/* Queue Panel */}
      <QueuePanel
        queue={queue}
        people={people}
        onReassign={async (id, p) => {
          try {
            setError(null);
            await reassignQueued(id, { id: p.id, slug: p.slug, display_name: p.display_name });
            await onQueueChanged();
            void tick('after-reassign');
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            await onQueueChanged();
          }
        }}
        onChanged={onQueueChanged}
      />

      {creatingPerson && (
        <CreatePersonDialog
          onClose={() => setCreatingPerson(false)}
          onCreate={async (input) => {
            await onCreatePerson(input);
            setCreatingPerson(false);
          }}
        />
      )}
    </div>
  );
}
