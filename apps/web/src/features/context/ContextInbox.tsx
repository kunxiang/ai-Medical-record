import { useCallback, useEffect, useState } from 'react';
import { Clock3, FilePlus2, LoaderCircle, MessageSquareText, RefreshCw } from 'lucide-react';
import type { Person } from '../../App.js';
import { api } from '../../api/client.js';
import {
  contextSessionsForPerson, getContextSession, type ContextLocalSession,
} from '../../offline/db.js';
import {
  contextLocalDate, createStandaloneContextPlaceholder, hydrateRemoteContextSession,
  syncAllContext,
} from '../../offline/context.js';
import { Alert } from '../../ui/Alert.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';

const STAGE_LABELS = { onsite: '现场问题', same_day: '当天补录', anytime: '随时记录' } as const;

function stateLabel(session: ContextLocalSession): string {
  if (session.sync_state === 'conflict') return '需要处理冲突';
  if (session.sync_state === 'needs_template') return '待选择记录类型';
  if (session.server_status === 'completed' || session.sync_state === 'completed') return '已完成';
  if (session.sync_state === 'synced') return '可继续补录';
  return '保存在本机，待同步';
}

export function ContextInbox({
  person, timezone, onOpen, refreshToken = 0,
}: {
  person: Person;
  timezone: string;
  onOpen: (sessionId: string) => void;
  refreshToken?: number;
}): JSX.Element {
  const [sessions, setSessions] = useState<ContextLocalSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (includeRemote = true) => {
    setLoading(true); setError(null);
    try {
      if (includeRemote && navigator.onLine) {
        await syncAllContext();
        const remote = await api.pendingContext(person.id, contextLocalDate(timezone));
        for (const item of remote.sessions) {
          const local = await getContextSession(item.id);
          if (!local) await hydrateRemoteContextSession(item.id, person.display_name);
        }
      }
      const local = await contextSessionsForPerson(person.id);
      setSessions(local
        .filter((session) => session.sync_state !== 'completed' && session.server_status !== 'completed')
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '情境记录加载失败');
      setSessions((await contextSessionsForPerson(person.id))
        .filter((session) => session.sync_state !== 'completed' && session.server_status !== 'completed'));
    } finally { setLoading(false); }
  }, [person.id, person.display_name, timezone]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  async function createStandalone(): Promise<void> {
    setError(null);
    try {
      const session = await createStandaloneContextPlaceholder(person);
      onOpen(session.id);
      await load(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法创建情境记录');
    }
  }

  return (
    <Card className="space-y-4" data-testid="context-inbox">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <MessageSquareText size={19} className="text-brand-600" />
            <h2 className="font-bold text-ink">情境与待补录</h2>
            {sessions.length > 0 && <Badge variant="warning">{sessions.length} 项</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted">记录空腹、症状、医嘱或用药变化；不依赖 AI，也不会自动改写医疗事实。</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" iconLeft={loading ? <LoaderCircle className="animate-spin" size={14} /> : <RefreshCw size={14} />} onClick={() => void load()}>
            刷新
          </Button>
          <Button size="sm" variant="outline" iconLeft={<FilePlus2 size={14} />} onClick={() => void createStandalone()} data-testid="context-new-anytime">
            随时记录
          </Button>
        </div>
      </div>
      {error && <Alert variant="warning"><span>{error}；本机草稿仍然保留。</span></Alert>}
      {sessions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-sm text-muted">
          当前没有待补录内容。
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => onOpen(session.id)}
              data-testid={`context-session-${session.id}`}
              className="flex min-h-20 items-center justify-between gap-3 rounded-xl border border-line bg-white px-4 py-3 text-left transition hover:border-brand-300 hover:bg-brand-50/30"
            >
              <div>
                <strong className="text-sm text-ink">{STAGE_LABELS[session.stage]}</strong>
                <p className="mt-1 text-xs text-muted">{stateLabel(session)}</p>
              </div>
              <Clock3 size={18} className="shrink-0 text-brand-600" />
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
