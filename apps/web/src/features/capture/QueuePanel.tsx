import { useState } from 'react';
import {
  CalendarDays, Camera, CheckCircle2, CircleAlert, Clock3, FileStack,
  LoaderCircle, RefreshCw, Trash2, UploadCloud, UserRoundCheck,
} from 'lucide-react';
import type { Person } from '../../App.js';
import type { CaptureRecord } from '../../offline/db.js';
import { discardCapture, retryTerminal } from '../../offline/queue.js';

const STATE_LABEL: Record<CaptureRecord['state'], string> = {
  draft: '拍摄中',
  pending_person: '待归人',
  pending: '待上传',
  uploading: '上传中',
  registering: '登记中',
  pending_discard: '待上报放弃',
  failed_terminal: '失败',
};

function StateIcon({ state }: { state: CaptureRecord['state'] }): JSX.Element {
  if (state === 'uploading' || state === 'registering') return <LoaderCircle className="spin" size={17} />;
  if (state === 'failed_terminal') return <CircleAlert size={17} />;
  if (state === 'pending_person') return <UserRoundCheck size={17} />;
  if (state === 'draft') return <FileStack size={17} />;
  if (state === 'pending_discard') return <Trash2 size={17} />;
  return <Clock3 size={17} />;
}

export function QueuePanel({
  queue, people, onReassign, onChanged,
}: {
  queue: CaptureRecord[];
  people: Person[];
  onReassign: (id: string, p: Person) => Promise<void>;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (queue.length === 0) {
    return (
      <section className="queue surface queue-empty" data-testid="queue-empty">
        <span className="empty-icon success"><CheckCircle2 size={26} /></span>
        <div><strong>队列为空，全部已上传</strong><p>新采集的文件会在这里显示上传进度。</p></div>
      </section>
    );
  }

  return (
    <section className="queue" data-testid="queue-panel">
      <div className="queue-title">
        <div><span className="eyebrow">离线队列</span><h2>上传进度</h2></div>
        <span className="queue-count-pill"><UploadCloud size={16} /> {queue.length} 项</span>
      </div>
      <ul>
        {queue.map((q) => (
          <li className={`queue-item state-${q.state}`} key={q.client_document_id} data-testid={`queue-item-${q.client_document_id}`} data-state={q.state}>
            <div className="queue-item-main">
              <span className="queue-file-icon">{q.source === 'camera' ? <Camera size={23} /> : <FileStack size={23} />}</span>
              <div className="queue-item-copy">
                <div className="queue-item-title">
                  <strong>{q.person_display_name ?? '未选择归属人'}</strong>
                  <span className={`state state-${q.state}`}><StateIcon state={q.state} /> {STATE_LABEL[q.state]}</span>
                </div>
                <div className="queue-meta">
                  <span><FileStack size={14} /> {q.page_count} 页</span>
                  <span><CalendarDays size={14} /> {new Date(q.captured_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                  {q.captured_at_from_exif && <span title="拍摄时间来自 EXIF">原始拍摄时间</span>}
                </div>
              </div>
            </div>
            {q.last_error && (
              <p className="error small error-callout" data-testid={`queue-error-${q.client_document_id}`}>
                <CircleAlert size={16} /> <span>{q.last_error.stage} · {q.last_error.code}：{q.last_error.message}</span>
              </p>
            )}
            {q.state === 'failed_terminal' && (
              <div className="queue-actions">
                <button className="secondary-button" onClick={() => void retryTerminal(q.client_document_id)} data-testid={`retry-${q.client_document_id}`}>
                  <RefreshCw size={16} /> 重试
                </button>
                {confirmId === q.client_document_id ? (
                  <button
                    className="danger"
                    data-testid={`discard-confirm-${q.client_document_id}`}
                    onClick={() => {
                      void discardCapture(q.client_document_id).then(onChanged);
                      setConfirmId(null);
                    }}
                  >
                    <Trash2 size={16} /> 确认放弃(本地这份将被删除且无法恢复)
                  </button>
                ) : (
                  <button className="danger" onClick={() => setConfirmId(q.client_document_id)}
                          data-testid={`discard-${q.client_document_id}`}>
                    <Trash2 size={16} /> 放弃
                  </button>
                )}
              </div>
            )}
            {['draft', 'pending_person', 'pending', 'failed_terminal'].includes(q.state) && people.length > 0 && (
              <div className="reassign-row">
                <label>调整归属</label>
                <div className="chips compact-chips">
                {people.map((p) => (
                  <button key={p.id} className="chip" onClick={() => void onReassign(q.client_document_id, p)}
                          data-testid={`reassign-${q.client_document_id}-${p.slug}`}>
                    {p.display_name}
                  </button>
                ))}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
