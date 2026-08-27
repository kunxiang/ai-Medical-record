import { useState } from 'react';
import {
  CalendarDays, Camera, CheckCircle2, CircleAlert, FileStack,
  RefreshCw, Trash2, UploadCloud,
} from 'lucide-react';
import type { Person } from '../../App.js';
import type { CaptureRecord } from '../../offline/db.js';
import { discardCapture, retryTerminal } from '../../offline/queue.js';
import { Card } from '../../ui/Card.js';
import { Button } from '../../ui/Button.js';
import { QueueStateBadge } from '../../ui/Badge.js';
import { Alert } from '../../ui/Alert.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { cn } from '../../ui/cn.js';

export function QueuePanel({
  queue,
  people,
  onReassign,
  onChanged,
}: {
  queue: CaptureRecord[];
  people: Person[];
  onReassign: (id: string, p: Person) => Promise<void>;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (queue.length === 0) {
    return (
      <EmptyState
        variant="card"
        icon={<CheckCircle2 size={28} className="text-success" />}
        title="队列为空，全部已上传"
        description="新采集的文件会在这里显示上传进度。"
        data-testid="queue-empty"
      />
    );
  }

  return (
    <Card className="space-y-4" data-testid="queue-panel">
      <div className="flex items-center justify-between pb-2 border-b border-line/60">
        <div>
          <span className="text-xs font-bold text-brand-600 tracking-wider uppercase">
            离线队列
          </span>
          <h2 className="text-lg font-bold text-ink tracking-tight">上传进度</h2>
        </div>
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-brand-50 text-brand-700 border border-brand-200/60">
          <UploadCloud size={15} /> {queue.length} 项
        </span>
      </div>

      <ul className="space-y-3">
        {queue.map((q) => (
          <li
            key={q.client_document_id}
            data-testid={`queue-item-${q.client_document_id}`}
            data-state={q.state}
            className={cn(
              'p-4 rounded-2xl border transition-all duration-150',
              q.state === 'failed_terminal'
                ? 'bg-danger-bg/40 border-danger-border/80'
                : q.state === 'pending_person'
                ? 'bg-warning-bg/40 border-warning-border/80'
                : 'bg-white/80 border-line hover:border-brand-200 shadow-2xs',
            )}
          >
            <div className="flex items-start gap-3.5">
              <div className="w-10 h-10 rounded-xl bg-surface-subtle text-muted flex items-center justify-center shrink-0 border border-line/60">
                {q.source === 'camera' ? <Camera size={20} /> : <FileStack size={20} />}
              </div>

              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-sm font-bold text-ink truncate">
                    {q.person_display_name ?? '未选择归属人'}
                  </strong>
                  <QueueStateBadge state={q.state} />
                </div>

                <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                  <span className="inline-flex items-center gap-1">
                    <FileStack size={13} /> {q.page_count} 页
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays size={13} />
                    {new Date(q.captured_at).toLocaleString('zh-CN', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  {q.captured_at_from_exif && (
                    <span
                      title="拍摄时间来自 EXIF"
                      className="px-1.5 py-0.5 rounded-md bg-brand-50 text-brand-700 font-medium text-[10px]"
                    >
                      EXIF时间
                    </span>
                  )}
                </div>
              </div>
            </div>

            {q.last_error && (
              <Alert
                variant="danger"
                className="mt-3 py-2 px-3 text-xs"
                icon={<CircleAlert size={15} />}
                data-testid={`queue-error-${q.client_document_id}`}
              >
                <span>
                  {q.last_error.stage} · {q.last_error.code}：{q.last_error.message}
                </span>
              </Alert>
            )}

            {q.state === 'failed_terminal' && (
              <div className="flex flex-wrap items-center gap-2 pt-3 mt-3 border-t border-line/60">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void retryTerminal(q.client_document_id)}
                  iconLeft={<RefreshCw size={14} />}
                  data-testid={`retry-${q.client_document_id}`}
                >
                  重试
                </Button>
                {confirmId === q.client_document_id ? (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      void discardCapture(q.client_document_id).then(onChanged);
                      setConfirmId(null);
                    }}
                    iconLeft={<Trash2 size={14} />}
                    data-testid={`discard-confirm-${q.client_document_id}`}
                  >
                    确认放弃(本地这份将被删除且无法恢复)
                  </Button>
                ) : (
                  <Button
                    variant="danger-soft"
                    size="sm"
                    onClick={() => setConfirmId(q.client_document_id)}
                    iconLeft={<Trash2 size={14} />}
                    data-testid={`discard-${q.client_document_id}`}
                  >
                    放弃
                  </Button>
                )}
              </div>
            )}

            {['draft', 'pending_person', 'pending', 'failed_terminal'].includes(q.state) &&
              people.length > 0 && (
                <div className="pt-3 mt-3 border-t border-line/50 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-muted">调整归属：</span>
                  <div className="flex flex-wrap gap-1.5">
                    {people.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => void onReassign(q.client_document_id, p)}
                        data-testid={`reassign-${q.client_document_id}-${p.slug}`}
                        className="px-2.5 py-1 rounded-lg text-xs font-medium bg-surface-subtle hover:bg-brand-50 hover:text-brand-700 text-ink-secondary border border-line/70 transition-colors cursor-pointer"
                      >
                        {p.display_name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
