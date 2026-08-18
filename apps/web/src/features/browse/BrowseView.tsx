import { useCallback, useEffect, useState } from 'react';
import type { DocumentListItemT } from '@amr/contracts';
import { api, auth, derivativeUrl } from '../../api/client.js';
import type { Person } from '../../App.js';
import type { CaptureRecord } from '../../offline/db.js';

type Doc = DocumentListItemT;

// spec m1-05 §5:时间轴按 capture_date 分组倒序;缩略图懒加载(接口是 302 ⇒ 原生 lazy 生效)。

export function BrowseView({ person, queue }: { person: Person | null; queue: CaptureRecord[] }): JSX.Element {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (reset: boolean) => {
      if (!person || loading) return;
      setLoading(true);
      setError(null);
      try {
        const res = await api.documents({
          person_id: person.id, limit: 20,
          ...(reset ? {} : cursor ? { cursor } : {}),
        });
        setDocs((prev) => (reset ? res.documents : [...prev, ...res.documents]));
        setCursor(res.next_cursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        setLoading(false);
      }
    },
    [person, cursor, loading],
  );

  useEffect(() => {
    setDocs([]);
    setCursor(null);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person?.id]);

  if (!person) return <main className="browse"><p className="muted">请先选择档案</p></main>;

  const groups = new Map<string, Doc[]>();
  for (const d of docs) {
    const list = groups.get(d.capture_date) ?? [];
    list.push(d);
    groups.set(d.capture_date, list);
  }
  const queuedForPerson = queue.filter((q) => q.person_id === person.id && q.state !== 'draft');

  return (
    <main className="browse" data-testid="browse">
      <h2>{person.display_name} 的档案</h2>

      {queuedForPerson.length > 0 && (
        <section className="pending-block" data-testid="browse-pending">
          <h3>待上传({queuedForPerson.length})</h3>
          <ul>
            {queuedForPerson.map((q) => (
              <li key={q.client_document_id} className="muted">
                {new Date(q.captured_at).toLocaleString()} · {q.page_count} 页 · {q.state}
              </li>
            ))}
          </ul>
        </section>
      )}

      {[...groups.entries()].map(([date, items]) => (
        <section key={date} className="day" data-testid={`day-${date}`}>
          <h3>{date}</h3>
          <div className="grid">
            {items.map((d) => (
              <a key={d.id} className="card" href={`#/documents/${d.id}`} data-testid={`doc-${d.short_id}`}>
                {d.first_page && d.first_page.mime_type !== 'application/pdf' ? (
                  <img
                    loading="lazy"          /* 302 重定向 ⇒ 原生懒加载真正生效(审核 #002 A-9) */
                    src={`${derivativeUrl(d.id, 1, 'thumb')}?access_token=${encodeURIComponent(auth.get() ?? '')}`}
                    alt=""
                    width={160}
                    height={200}
                    data-testid={`thumb-${d.short_id}`}
                  />
                ) : (
                  <div className="placeholder" data-testid={`placeholder-${d.short_id}`}>PDF</div>
                )}
                <span className="muted">{d.page_count} 页</span>
              </a>
            ))}
          </div>
        </section>
      ))}

      {error && <p className="error">{error}</p>}
      {cursor && (
        <button onClick={() => void load(false)} disabled={loading} data-testid="load-more">
          {loading ? '加载中…' : '加载更多'}
        </button>
      )}
      {docs.length === 0 && !loading && <p className="muted" data-testid="browse-empty">还没有已上传的文档</p>}
    </main>
  );
}
