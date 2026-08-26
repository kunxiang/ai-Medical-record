import { useRef, useState } from 'react';
import {
  Camera, Check, CheckCircle2, FileStack, Images, LockKeyhole, Plus, ShieldCheck,
  Sparkles, UploadCloud, UserRound, UsersRound,
} from 'lucide-react';
import type { CreatePersonInput } from '../../api/client.js';
import type { Person } from '../../App.js';
import { CaptureRejected, appendDraftPage, finalizeDraft, preparePage, reassignQueued } from '../../offline/capture.js';
import { ensureRoomFor } from '../../offline/persist.js';
import type { CaptureRecord } from '../../offline/db.js';
import { QueuePanel } from './QueuePanel.js';
import { CreatePersonDialog } from './CreatePersonDialog.js';
import { tick } from '../../offline/queue.js';

// spec m1-05 §3/§4。连拍 = 重复调起单张 capture="environment"(iOS 上 multiple 被忽略);
// 每页读入后立即落盘 draft(内存里的照片会随标签页被回收而全丢)。

const RELATION_LABELS: Record<string, string> = {
  self: '本人',
  spouse: '配偶',
  parent: '父母',
  child: '子女',
  sibling: '兄弟姐妹',
  other: '其他',
};

export function CaptureView({
  people, selected, onSelect, onCreatePerson, queue, onQueueChanged,
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
    <div className="capture page-view">
      <header className="page-heading">
        <div>
          <span className="eyebrow">采集中心</span>
          <h1>保存一份医疗记录</h1>
          <p>拍照或导入文件，MediReco 会保留原件并自动整理。</p>
        </div>
        <span className="security-pill"><ShieldCheck size={18} /> 原件零改动</span>
      </header>

      <section className="surface person-picker" data-testid="person-picker">
        <div className="section-heading person-picker-heading">
          <span className="section-icon"><UsersRound size={20} /></span>
          <div>
            <h2>这是谁的记录？</h2>
            <p>上传前必须确认归属，避免家庭成员档案混淆。</p>
          </div>
          <button type="button" className="add-person-button" onClick={() => setCreatingPerson(true)}
                  data-testid="add-person">
            <Plus size={17} /> 添加成员
          </button>
        </div>
        <div className="chips person-chips">
          {people.map((p) => (
            <button
              key={p.id}
              className={selected?.id === p.id ? 'chip on' : 'chip'}
              onClick={() => onSelect(p)}
              data-testid={`person-${p.slug}`}
            >
              <span className="person-avatar">{p.display_name.slice(0, 1)}</span>
              <span className="person-chip-copy">
                <strong>{p.display_name}</strong>
                <small>{RELATION_LABELS[p.relation_to_owner] ?? '家庭成员'}</small>
              </span>
              {selected?.id === p.id && <Check className="chip-check" size={17} />}
            </button>
          ))}
          {people.length === 0 && (
            <div className="inline-empty"><UserRound size={20} /><span>暂无档案，请先添加家庭成员</span></div>
          )}
        </div>
        {!selected && (
          <p className="banner warn" data-testid="no-person-warning">
            未选择归属人：仍可拍照，但在选人之前不会上传。
          </p>
        )}
      </section>

      <section className="surface capture-studio">
        <div className="section-heading capture-heading">
          <span className="section-icon accent"><Sparkles size={20} /></span>
          <div>
            <h2>{draftPages > 0 ? '继续添加这一份记录' : '添加医疗文件'}</h2>
            <p>{draftPages > 0 ? `草稿已安全保存 ${draftPages} 页，可以继续拍摄或完成归档。` : '支持照片、相册多选和 PDF，单个文件最大 50 MiB。'}</p>
          </div>
        </div>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden
               onChange={(e) => { void ingest(e.target.files, 'camera'); e.target.value = ''; }}
               data-testid="input-camera" />
        <input ref={albumRef} type="file" accept="image/*,application/pdf" multiple hidden
               onChange={(e) => { void ingest(e.target.files, 'album'); e.target.value = ''; }}
               data-testid="input-album" />
        <div className="capture-actions">
          <button className="capture-action camera-action" onClick={() => cameraRef.current?.click()} data-testid="btn-camera">
            <span className="action-icon"><Camera size={28} /></span>
            <span className="action-copy">
              <strong>{draftPages > 0 ? '继续拍照' : '拍照采集'}</strong>
              <small>{draftPages > 0 ? `已保存 ${draftPages} 页` : '适合纸质病历与报告'}</small>
            </span>
            <span className="action-arrow">→</span>
          </button>
          <button className="capture-action" onClick={() => albumRef.current?.click()} data-testid="btn-album">
            <span className="action-icon soft"><Images size={27} /></span>
            <span className="action-copy">
              <strong>相册 / PDF</strong>
              <small>支持一次选择多个文件</small>
            </span>
            <span className="action-arrow">→</span>
          </button>
        </div>
        {draftPages > 0 && (
          <div className="draft-bar">
            <span className="draft-icon"><FileStack size={21} /></span>
            <span><strong>当前草稿 · {draftPages} 页</strong><small>每一页都已保存在本机</small></span>
            <button className="primary finish-button" onClick={() => void finish()} data-testid="btn-finish">
              <CheckCircle2 size={18} /> 完成这份({draftPages} 页)
            </button>
          </div>
        )}
        {error && <p className="error error-callout" data-testid="capture-error">{error}</p>}
      </section>

      <section className={pending.length > 0 ? 'upload-summary active' : 'upload-summary complete'}>
        <span className="summary-icon">{pending.length > 0 ? <UploadCloud size={24} /> : <CheckCircle2 size={24} />}</span>
        <span className="summary-copy">
          <strong data-testid="queue-count">{pending.length} 张待上传</strong>
          <small data-testid={pending.length > 0 ? 'queue-hint' : undefined}>
            {pending.length > 0 ? '保持应用打开直到上传完成' : '全部已安全上传到档案库'}
          </small>
        </span>
        <span className="summary-security"><LockKeyhole size={15} /> 加密传输</span>
        {needsPerson.length > 0 && (
          <p className="banner warn" data-testid="needs-person">
            {needsPerson.length} 张待归人，选人后才会上传
          </p>
        )}
      </section>

      <QueuePanel
        queue={queue}
        people={people}
        onReassign={async (id, p) => {
          // 上传已开始时 reassignQueued 会拒绝(key 已由 person 决定)——
          // 按钮此时本应已消失,但状态刷新与点击之间仍有窗口,理由要让用户看见
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
