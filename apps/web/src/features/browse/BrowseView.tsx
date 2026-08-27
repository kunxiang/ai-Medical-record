import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { EncounterProposal, FacilityProposal, type DocumentListItemT, type NormalizationDecisionT } from '@amr/contracts';
import {
  AlertTriangle, Archive, Building2, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3,
  FileImage, FileText, LoaderCircle, MapPin, Maximize2, RotateCcw, ShieldCheck, Trash2,
  UploadCloud, UserRoundCog, X,
} from 'lucide-react';
import { uuidv7 } from 'uuidv7';
import { api, auth, derivativeUrl } from '../../api/client.js';
import type { Person } from '../../App.js';
import type { CaptureRecord } from '../../offline/db.js';

type Doc = DocumentListItemT;

const DOC_TYPE_LABEL: Record<string, string> = {
  lab_report: '检验报告', imaging_report: '影像报告', discharge_summary: '出院记录',
  prescription: '处方', visit_note: '门诊记录', invoice: '票据', other: '医疗文件', unknown: '待分类',
};
const ENCOUNTER_TYPE_LABEL: Record<string, string> = {
  outpatient: '门诊', inpatient: '住院', emergency: '急诊', checkup: '体检', other: '其他',
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
  const [decisions, setDecisions] = useState<NormalizationDecisionT[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewAction, setReviewAction] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [documentAction, setDocumentAction] = useState(false);

  const load = useCallback(
    async (reset: boolean) => {
      if (!person || loading) return;
      setLoading(true);
      setError(null);
      try {
        const res = await api.documents({
          person_id: person.id, limit: 20,
          include_archived: showArchived,
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
    [person, cursor, loading, showArchived],
  );

  useEffect(() => {
    setDocs([]);
    setCursor(null);
    setViewer(null);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person?.id, showArchived]);

  useEffect(() => {
    if (!person) {
      setDecisions([]);
      return;
    }
    let cancelled = false;
    setReviewLoading(true);
    setReviewError(null);
    void api.normalizationDecisions()
      .then((result) => {
        if (!cancelled) setDecisions([...result.decisions].reverse());
      })
      .catch((cause: unknown) => {
        if (!cancelled) setReviewError(cause instanceof Error ? cause.message : '机构映射加载失败');
      })
      .finally(() => {
        if (!cancelled) setReviewLoading(false);
      });
    return () => { cancelled = true; };
  }, [person?.id]);

  const decideNormalization = useCallback(async (
    item: NormalizationDecisionT,
    decision: 'confirmed' | 'rejected',
  ) => {
    if (decision === 'rejected') {
      const message = item.kind === 'facility'
        ? '拒绝后，这些机构原文将保持未归一。确认拒绝吗？'
        : '拒绝后，这些文档不会归入同一次就诊。确认拒绝吗？';
      if (!window.confirm(message)) return;
    }
    setReviewAction(item.id);
    setReviewError(null);
    try {
      const result = await api.confirmNormalization(item.id, decision, uuidv7());
      setDecisions((current) => current.map((entry) => entry.id === item.id ? result.decision : entry));
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : '机构映射提交失败');
    } finally {
      setReviewAction(null);
    }
  }, []);

  const acknowledgePersonCheck = useCallback(async (doc: Doc) => {
    const reason = window.prompt('请填写确认理由', '已核对原件，档案归属无误');
    if (!reason?.trim()) return;
    setDocumentAction(true);
    setError(null);
    try {
      const result = await api.acknowledgePersonCheck(doc.id, reason.trim(), uuidv7());
      setDocs((current) => current.map((item) => item.id === doc.id
        ? { ...item, person_check_ack_at: result.person_check_ack_at }
        : item));
      setViewer((current) => current?.doc.id === doc.id
        ? { ...current, doc: { ...current.doc, person_check_ack_at: result.person_check_ack_at } }
        : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '归属确认失败');
    } finally {
      setDocumentAction(false);
    }
  }, []);

  const toggleArchive = useCallback(async (doc: Doc) => {
    const archived = doc.archived_at === null;
    const reason = window.prompt(archived ? '请填写归档理由' : '请填写恢复理由', archived ? '不再显示在日常档案中' : '恢复到日常档案');
    if (!reason?.trim()) return;
    setDocumentAction(true);
    setError(null);
    try {
      const result = await api.archiveDocument(doc.id, archived, reason.trim(), uuidv7());
      setDocs((current) => showArchived
        ? current.map((item) => item.id === doc.id ? { ...item, archived_at: result.archived_at } : item)
        : current.filter((item) => item.id !== doc.id));
      setViewer(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '文档归档操作失败');
    } finally {
      setDocumentAction(false);
    }
  }, [showArchived]);

  const reassignDocument = useCallback(async (doc: Doc) => {
    if (!person) return;
    const targets = people.filter((item) => item.id !== doc.person_id);
    if (targets.length === 0) {
      setError('没有可接收这份文档的其他家庭成员');
      return;
    }
    const selected = window.prompt(
      `请选择目标档案编号：\n${targets.map((item, index) => `${index + 1}. ${item.display_name}`).join('\n')}`,
      '1',
    );
    if (selected === null) return;
    const target = targets[Number(selected) - 1];
    if (!target) {
      setError('目标档案编号无效');
      return;
    }
    const reason = window.prompt('请填写纠正理由', '核对原件后确认归属错误');
    if (!reason?.trim()) return;
    if (!window.confirm(`确认把这份文档从 ${person.display_name} 调整到 ${target.display_name}？原件不会移动或删除。`)) return;
    setDocumentAction(true);
    setError(null);
    try {
      await api.reassignDocument(doc.id, target.id, reason.trim(), uuidv7());
      setDocs((current) => current.filter((item) => item.id !== doc.id));
      setViewer(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '归人纠正失败');
    } finally {
      setDocumentAction(false);
    }
  }, [people, person]);

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
  const facilityDecisions = decisions.filter((item) => item.kind === 'facility');
  const encounterDecisions = decisions.filter((item) => {
    if (item.kind !== 'encounter') return false;
    const proposal = EncounterProposal.safeParse(item.proposal);
    return proposal.success && proposal.data.person_id === person.id;
  });

  return (
    <div className="browse page-view" data-testid="browse">
      <header className="page-heading browse-heading">
        <div>
          <span className="eyebrow">健康档案库</span>
          <h1>{person.display_name} 的档案</h1>
          <p>{docs.length > 0 ? `已加载 ${docs.length} 份记录，按采集日期整理。` : '按时间浏览已安全归档的医疗记录。'}</p>
        </div>
        <div className="browse-heading-actions">
          <button type="button" className={showArchived ? 'archive-filter on' : 'archive-filter'} onClick={() => setShowArchived((value) => !value)}>
            <Archive size={15} />{showArchived ? '含已归档' : '查看已归档'}
          </button>
          <span className="archive-avatar">{person.display_name.slice(0, 1)}</span>
        </div>
      </header>

      <section className="archive-switcher" aria-label="选择家庭成员">
        {people.map((item) => (
          <button key={item.id} className={item.id === person.id ? 'archive-person on' : 'archive-person'} onClick={() => onSelect(item)}>
            <span>{item.display_name.slice(0, 1)}</span>
            <strong>{item.display_name}</strong>
          </button>
        ))}
      </section>

      {(reviewLoading || facilityDecisions.length > 0) && (
        <section className="normalization-review surface" data-testid="facility-review">
          <div className="normalization-review-heading">
            <span className="normalization-review-icon"><Building2 size={19} /></span>
            <div>
              <h2>机构名称审核</h2>
              <p>AI 只提出映射建议；确认后才会成为可回放的人工决定。</p>
            </div>
            {reviewLoading && <LoaderCircle className="spin" size={18} aria-label="加载中" />}
          </div>

          <div className="normalization-list">
            {facilityDecisions.map((item) => {
              const parsed = FacilityProposal.safeParse(item.proposal);
              if (!parsed.success) return (
                <article key={item.id} className="normalization-item invalid">
                  <AlertTriangle size={18} /><p>这条机构建议的数据格式无效，需要管理员检查。</p>
                </article>
              );
              const proposal = parsed.data;
              const busy = reviewAction === item.id;
              const stateLabel = item.state === 'proposed' ? '待确认' : item.state === 'confirmed' ? '已确认' : '已拒绝';
              return (
                <article key={item.id} className={`normalization-item state-${item.state}`} data-testid={`facility-decision-${item.id}`}>
                  <div className="normalization-copy">
                    <div className="normalization-title-row">
                      <strong>{proposal.facility.name}</strong>
                      <span className={`decision-state ${item.state}`}>{stateLabel}</span>
                    </div>
                    <p className="normalization-aliases">
                      原文：{proposal.matched_raw_names.join('、')}
                    </p>
                    <p className="normalization-reason">{proposal.reason}</p>
                    <div className="normalization-meta">
                      {proposal.facility.city && <span><MapPin size={13} />{proposal.facility.city}</span>}
                      {proposal.facility.level && <span>{proposal.facility.level}</span>}
                      <span>置信度 {Math.round(proposal.confidence * 100)}%</span>
                    </div>
                  </div>
                  {item.state === 'proposed' && (
                    <div className="normalization-actions">
                      <button type="button" className="review-reject" disabled={busy} onClick={() => void decideNormalization(item, 'rejected')}>
                        <X size={16} />拒绝
                      </button>
                      <button type="button" className="review-confirm" disabled={busy} onClick={() => void decideNormalization(item, 'confirmed')}>
                        {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}确认
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {encounterDecisions.length > 0 && (
        <section className="normalization-review encounter-review surface" data-testid="encounter-review">
          <div className="normalization-review-heading">
            <span className="normalization-review-icon"><CalendarDays size={19} /></span>
            <div>
              <h2>就诊归组建议</h2>
              <p>确认后才会把两份文档归入同一次就诊。</p>
            </div>
          </div>
          <div className="normalization-list">
            {encounterDecisions.map((item) => {
              const parsed = EncounterProposal.safeParse(item.proposal);
              if (!parsed.success) return null;
              const proposal = parsed.data;
              const busy = reviewAction === item.id;
              const stateLabel = item.state === 'proposed' ? '待确认' : item.state === 'confirmed' ? '已确认' : '已拒绝';
              return (
                <article key={item.id} className={`normalization-item state-${item.state}`} data-testid={`encounter-decision-${item.id}`}>
                  <div className="normalization-copy">
                    <div className="normalization-title-row">
                      <strong>{displayDate(proposal.occurred_on)} 的就诊</strong>
                      <span className={`decision-state ${item.state}`}>{stateLabel}</span>
                      {proposal.grouping_basis === 'capture_date_degraded' && <span className="weak-basis">判据较弱</span>}
                    </div>
                    <p className="normalization-aliases">文档：{proposal.document_short_ids.join('、')}</p>
                    <p className="normalization-reason">{proposal.reason}</p>
                    <div className="normalization-meta">
                      <span>{ENCOUNTER_TYPE_LABEL[proposal.encounter_type] ?? proposal.encounter_type}</span>
                      <span>置信度 {Math.round(proposal.confidence * 100)}%</span>
                    </div>
                  </div>
                  {item.state === 'proposed' && (
                    <div className="normalization-actions">
                      <button type="button" className="review-reject" disabled={busy} onClick={() => void decideNormalization(item, 'rejected')}>
                        <X size={16} />拒绝
                      </button>
                      <button type="button" className="review-confirm" disabled={busy} onClick={() => void decideNormalization(item, 'confirmed')}>
                        {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}确认归组
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {reviewError && <p className="error normalization-error"><AlertTriangle size={16} />{reviewError}</p>}

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
                  {d.archived_at && <span className="archived-badge"><Archive size={13} /> 已归档</span>}
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
            <span className="viewer-actions">
              {viewer.doc.person_check === 'mismatch' && !viewer.doc.person_check_ack_at && (
                <>
                  <button type="button" onClick={() => void acknowledgePersonCheck(viewer.doc)} disabled={documentAction} aria-label="确认档案归属无误">
                    <ShieldCheck size={19} />
                  </button>
                  <button type="button" onClick={() => void reassignDocument(viewer.doc)} disabled={documentAction} aria-label="纠正档案归属">
                    <UserRoundCog size={19} />
                  </button>
                </>
              )}
              <button type="button" onClick={() => void toggleArchive(viewer.doc)} disabled={documentAction} aria-label={viewer.doc.archived_at ? '恢复文档' : '归档文档'}>
                {viewer.doc.archived_at ? <RotateCcw size={19} /> : <Trash2 size={19} />}
              </button>
              <button type="button" onClick={() => setViewer(null)} aria-label="关闭大图" data-testid="viewer-close" autoFocus>
                <X size={22} />
              </button>
            </span>
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
