import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DocumentListItemT } from '@amr/contracts';
import {
  AlertTriangle, Archive, CalendarDays, ChevronLeft, ChevronRight, Clock3, FileImage,
  FileText, LoaderCircle, MapPin, Maximize2, UploadCloud, X,
} from 'lucide-react';
import { api, auth, derivativeUrl } from '../../api/client.js';
import type { Person } from '../../App.js';
import type { CaptureRecord } from '../../offline/db.js';

type Doc = DocumentListItemT;

const DOC_TYPE_LABEL: Record<string, string> = {
  lab_report: '检验报告', imaging_report: '影像报告', discharge_summary: '出院记录',
  prescription: '处方', visit_note: '门诊记录', invoice: '票据', other: '医疗文件', unknown: '待分类',
};

function displayDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  });
}

// spec m1-05 §5:时间轴按 capture_date 分组倒序;缩略图懒加载(接口是 302 ⇒ 原生 lazy 生效)。

export function BrowseView({
  person, people, onSelect, queue,
}: {
  person: Person | null;
  people: Person[];
  onSelect: (person: Person) => void;
  queue: CaptureRecord[];
}): JSX.Element {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ doc: Doc; page: number } | null>(null);

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
    setViewer(null);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person?.id]);

  useEffect(() => {
    if (!viewer) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setViewer(null);
      if (event.key === 'ArrowLeft') {
        setViewer((current) => current ? { ...current, page: Math.max(1, current.page - 1) } : null);
      }
      if (event.key === 'ArrowRight') {
        setViewer((current) => current
          ? { ...current, page: Math.min(current.doc.page_count, current.page + 1) }
          : null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [viewer?.doc.id]);

  if (!person) return (
    <div className="browse page-view">
      <div className="surface page-empty"><Archive size={30} /><h2>请先选择档案</h2><p>选择一位家庭成员后即可浏览记录。</p></div>
    </div>
  );

  const groups = new Map<string, Doc[]>();
  for (const d of docs) {
    const list = groups.get(d.capture_date) ?? [];
    list.push(d);
    groups.set(d.capture_date, list);
  }
  const queuedForPerson = queue.filter((q) => q.person_id === person.id && q.state !== 'draft');

  return (
    <div className="browse page-view" data-testid="browse">
      <header className="page-heading browse-heading">
        <div>
          <span className="eyebrow">健康档案库</span>
          <h1>{person.display_name} 的档案</h1>
          <p>{docs.length > 0 ? `已加载 ${docs.length} 份记录，按采集日期整理。` : '按时间浏览已安全归档的医疗记录。'}</p>
        </div>
        <span className="archive-avatar">{person.display_name.slice(0, 1)}</span>
      </header>

      <section className="archive-switcher" aria-label="选择家庭成员">
        {people.map((item) => (
          <button key={item.id} className={item.id === person.id ? 'archive-person on' : 'archive-person'} onClick={() => onSelect(item)}>
            <span>{item.display_name.slice(0, 1)}</span>
            <strong>{item.display_name}</strong>
          </button>
        ))}
      </section>

      {queuedForPerson.length > 0 && (
        <section className="pending-block surface" data-testid="browse-pending">
          <div className="pending-heading"><UploadCloud size={20} /><div><h3>待上传({queuedForPerson.length})</h3><p>这些文件已安全保存在当前设备。</p></div></div>
          <ul>
            {queuedForPerson.map((q) => (
              <li key={q.client_document_id}>
                <Clock3 size={15} /> {new Date(q.captured_at).toLocaleString()} · {q.page_count} 页 · {q.state}
              </li>
            ))}
          </ul>
        </section>
      )}

      {[...groups.entries()].map(([date, items]) => (
        <section key={date} className="day" data-testid={`day-${date}`}>
          <div className="day-heading"><CalendarDays size={18} /><h3>{displayDate(date)}</h3><span>{items.length} 份</span></div>
          <div className="grid">
            {items.map((d) => (
              <button
                key={d.id}
                type="button"
                className="card"
                onClick={() => setViewer({ doc: d, page: 1 })}
                aria-label={`查看${d.facility_name ?? d.original_filename ?? '医疗记录'}大图`}
                data-testid={`doc-${d.short_id}`}
              >
                <div className="card-preview">
                  {d.first_page && d.first_page.mime_type !== 'application/pdf' ? (
                  <img
                    loading="lazy"          /* 302 重定向 ⇒ 原生懒加载真正生效(审核 #002 A-9) */
                    src={`${derivativeUrl(d.id, 1, 'thumb')}?access_token=${encodeURIComponent(auth.get() ?? '')}`}
                    alt={`${DOC_TYPE_LABEL[d.doc_type] ?? '医疗记录'}缩略图`}
                    width={160}
                    height={200}
                    data-testid={`thumb-${d.short_id}`}
                  />
                ) : (
                  <div className="placeholder" data-testid={`placeholder-${d.short_id}`}><FileText size={34} /><strong>PDF</strong></div>
                )}
                  <span className="page-badge">{d.page_count} 页</span>
                </div>
                <span className="card-body">
                  <span className="card-type"><FileImage size={15} /> {DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type}</span>
                  <strong>{d.facility_name ?? d.original_filename ?? '医疗记录'}</strong>
                  <span className="card-meta">
                    {d.facility_name && <span><MapPin size={13} /> {d.facility_name}</span>}
                    <span>{new Date(d.captured_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                  </span>
                  {d.person_check === 'mismatch' && !d.person_check_ack_at && <span className="review-badge"><AlertTriangle size={13} /> 待核对归属</span>}
                </span>
                <ChevronRight className="card-chevron" size={19} />
              </button>
            ))}
          </div>
        </section>
      ))}

      {error && <p className="error error-callout"><AlertTriangle size={17} /> {error}</p>}
      {cursor && (
        <button className="load-more" onClick={() => void load(false)} disabled={loading} data-testid="load-more">
          {loading ? <><LoaderCircle className="spin" size={18} /> 加载中…</> : '加载更多'}
        </button>
      )}
      {loading && docs.length === 0 && <div className="surface loading-state"><LoaderCircle className="spin" size={25} /><span>正在加载档案…</span></div>}
      {docs.length === 0 && !loading && (
        <div className="surface page-empty" data-testid="browse-empty">
          <span className="empty-icon"><Archive size={28} /></span>
          <h2>还没有已上传的文档</h2>
          <p>切换到「采集」，拍照或导入第一份医疗记录。</p>
        </div>
      )}

      {viewer && createPortal(
        <div
          className="document-viewer"
          role="dialog"
          aria-modal="true"
          aria-label="病历大图预览"
          data-testid="document-viewer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setViewer(null);
          }}
        >
          <header className="viewer-toolbar">
            <div>
              <span className="viewer-type"><Maximize2 size={15} /> 大图预览</span>
              <strong>{viewer.doc.facility_name ?? viewer.doc.original_filename ?? '医疗记录'}</strong>
            </div>
            <button type="button" onClick={() => setViewer(null)} aria-label="关闭大图" data-testid="viewer-close" autoFocus>
              <X size={22} />
            </button>
          </header>

          <div className="viewer-stage">
            <button
              type="button"
              className="viewer-arrow previous"
              onClick={() => setViewer((current) => current ? { ...current, page: Math.max(1, current.page - 1) } : null)}
              disabled={viewer.page === 1}
              aria-label="上一页"
              data-testid="viewer-previous"
            >
              <ChevronLeft size={27} />
            </button>

            <div
              className="viewer-media"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setViewer(null);
              }}
            >
              {viewer.doc.first_page?.mime_type === 'application/pdf' ? (
                <div className="viewer-pdf-message">
                  <FileText size={45} />
                  <strong>PDF 大图预览即将支持</strong>
                  <span>当前可确认文件已经安全归档。</span>
                </div>
              ) : (
                <img
                  key={`${viewer.doc.id}-${viewer.page}`}
                  src={`${derivativeUrl(viewer.doc.id, viewer.page, 'preview')}?access_token=${encodeURIComponent(auth.get() ?? '')}`}
                  alt={`${DOC_TYPE_LABEL[viewer.doc.doc_type] ?? '医疗记录'}第 ${viewer.page} 页`}
                  data-testid="viewer-image"
                />
              )}
            </div>

            <button
              type="button"
              className="viewer-arrow next"
              onClick={() => setViewer((current) => current
                ? { ...current, page: Math.min(current.doc.page_count, current.page + 1) }
                : null)}
              disabled={viewer.page === viewer.doc.page_count}
              aria-label="下一页"
              data-testid="viewer-next"
            >
              <ChevronRight size={27} />
            </button>
          </div>

          <footer className="viewer-footer">
            <span>{displayDate(viewer.doc.capture_date)}</span>
            <strong>第 {viewer.page} / {viewer.doc.page_count} 页</strong>
            <span>Esc 关闭 · 方向键翻页</span>
          </footer>
        </div>,
        document.body,
      )}
    </div>
  );
}
