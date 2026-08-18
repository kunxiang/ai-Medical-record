import { useRef, useState } from 'react';
import type { Person } from '../../App.js';
import { CaptureRejected, appendDraftPage, finalizeDraft, preparePage, reassignQueued } from '../../offline/capture.js';
import { ensureRoomFor } from '../../offline/persist.js';
import type { CaptureRecord } from '../../offline/db.js';
import { QueuePanel } from './QueuePanel.js';
import { tick } from '../../offline/queue.js';

// spec m1-05 §3/§4。连拍 = 重复调起单张 capture="environment"(iOS 上 multiple 被忽略);
// 每页读入后立即落盘 draft(内存里的照片会随标签页被回收而全丢)。

export function CaptureView({
  people, selected, onSelect, queue, onQueueChanged,
}: {
  people: Person[];
  selected: Person | null;
  onSelect: (p: Person) => void;
  queue: CaptureRecord[];
  onQueueChanged: () => Promise<void>;
}): JSX.Element {
  const cameraRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftPages, setDraftPages] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const pending = queue.filter((q) => q.state !== 'draft');
  const needsPerson = queue.filter((q) => q.state === 'pending_person');

  async function ingest(files: FileList | null, source: 'camera' | 'album'): Promise<void> {
    if (!files?.length) return;
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const room = await ensureRoomFor(file.size);
        if (!room.ok) throw new CaptureRejected(room.reason!);
        const page = await preparePage(file);          // 校验 + 物化 Blob + 摘要 + 尺寸 + EXIF
        const rec = await appendDraftPage({
          draftId: draftId ?? undefined,
          person: selected ? { id: selected.id, slug: selected.slug, display_name: selected.display_name } : null,
          page,
          source: page.mime_type === 'application/pdf' ? 'pdf' : source,
        });
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
    <main className="capture">
      <section className="person-picker" data-testid="person-picker">
        <label>归属人</label>
        <div className="chips">
          {people.map((p) => (
            <button
              key={p.id}
              className={selected?.id === p.id ? 'chip on' : 'chip'}
              onClick={() => onSelect(p)}
              data-testid={`person-${p.slug}`}
            >
              {p.display_name}
            </button>
          ))}
          {people.length === 0 && <span className="muted">暂无档案(需先联网建档)</span>}
        </div>
        {!selected && (
          <p className="banner warn" data-testid="no-person-warning">
            未选择归属人:仍可拍照,但在选人之前不会上传。
          </p>
        )}
      </section>

      <section className="shoot">
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden
               onChange={(e) => { void ingest(e.target.files, 'camera'); e.target.value = ''; }}
               data-testid="input-camera" />
        <input ref={albumRef} type="file" accept="image/*,application/pdf" multiple hidden
               onChange={(e) => { void ingest(e.target.files, 'album'); e.target.value = ''; }}
               data-testid="input-album" />
        <button className="primary" onClick={() => cameraRef.current?.click()} data-testid="btn-camera">
          拍照{draftPages > 0 ? `(继续,已 ${draftPages} 页)` : ''}
        </button>
        <button onClick={() => albumRef.current?.click()} data-testid="btn-album">相册 / PDF</button>
        {draftPages > 0 && (
          <button className="primary" onClick={() => void finish()} data-testid="btn-finish">
            完成这份({draftPages} 页)
          </button>
        )}
        {error && <p className="error" data-testid="capture-error">{error}</p>}
      </section>

      <section className="status">
        <strong data-testid="queue-count">{pending.length} 张待上传</strong>
        {pending.length > 0 && (
          <p className="muted" data-testid="queue-hint">保持应用打开直到上传完成</p>
        )}
        {needsPerson.length > 0 && (
          <p className="banner warn" data-testid="needs-person">
            {needsPerson.length} 张待归人,选人后才会上传
          </p>
        )}
      </section>

      <QueuePanel
        queue={queue}
        people={people}
        onReassign={async (id, p) => {
          await reassignQueued(id, { id: p.id, slug: p.slug, display_name: p.display_name });
          await onQueueChanged();
          void tick('after-reassign');
        }}
        onChanged={onQueueChanged}
      />
    </main>
  );
}
