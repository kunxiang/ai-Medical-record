import { useState } from 'react';
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
    return <section className="queue" data-testid="queue-empty"><p className="muted">队列为空,全部已上传</p></section>;
  }

  return (
    <section className="queue" data-testid="queue-panel">
      <h2>队列</h2>
      <ul>
        {queue.map((q) => (
          <li key={q.client_document_id} data-testid={`queue-item-${q.client_document_id}`} data-state={q.state}>
            <div className="row">
              <span className="state">{STATE_LABEL[q.state]}</span>
              <span>{q.person_display_name ?? '未选人'}</span>
              <span className="muted">{q.page_count} 页</span>
              {q.captured_at_from_exif && <span className="muted" title="拍摄时间来自 EXIF">📅 原始拍摄时间</span>}
            </div>
            {q.last_error && (
              <p className="error small" data-testid={`queue-error-${q.client_document_id}`}>
                {q.last_error.stage} · {q.last_error.code}:{q.last_error.message}
              </p>
            )}
            {q.state === 'failed_terminal' && (
              <div className="row">
                <button onClick={() => void retryTerminal(q.client_document_id)} data-testid={`retry-${q.client_document_id}`}>
                  重试
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
                    确认放弃(本地这份将被删除且无法恢复)
                  </button>
                ) : (
                  <button className="danger" onClick={() => setConfirmId(q.client_document_id)}
                          data-testid={`discard-${q.client_document_id}`}>
                    放弃
                  </button>
                )}
              </div>
            )}
            {['draft', 'pending_person', 'pending', 'failed_terminal'].includes(q.state) && people.length > 1 && (
              <div className="row">
                <label className="muted">改归属:</label>
                {people.map((p) => (
                  <button key={p.id} className="chip" onClick={() => void onReassign(q.client_document_id, p)}
                          data-testid={`reassign-${q.client_document_id}-${p.slug}`}>
                    {p.display_name}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
