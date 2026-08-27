import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { EncounterProposal, FacilityProposal, type DocumentListItemT, type NormalizationDecisionT } from '@amr/contracts';
import {
  AlertTriangle, Archive, Building2, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3,
  FileImage, FileText, LoaderCircle, MapPin, Maximize2, RotateCcw, RotateCw, ShieldCheck, Trash2,
  UploadCloud, UserRoundCog, X,
} from 'lucide-react';
import { uuidv7 } from 'uuidv7';
import { api, auth, derivativeUrl } from '../../api/client.js';
import type { Person } from '../../App.js';
import type { CaptureRecord } from '../../offline/db.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Card } from '../../ui/Card.js';
import { Button } from '../../ui/Button.js';
import { Badge, NormalizationStateBadge } from '../../ui/Badge.js';
import { Alert } from '../../ui/Alert.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { cn } from '../../ui/cn.js';

type Doc = DocumentListItemT;

const DOC_TYPE_LABEL: Record<string, string> = {
  lab_report: '检验报告',
  imaging_report: '影像报告',
  discharge_summary: '出院记录',
  prescription: '处方',
  visit_note: '门诊记录',
  invoice: '票据',
  other: '医疗文件',
  unknown: '待分类',
};

const ENCOUNTER_TYPE_LABEL: Record<string, string> = {
  outpatient: '门诊',
  inpatient: '住院',
  emergency: '急诊',
  checkup: '体检',
  other: '其他',
};

function displayDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
}

export function BrowseView({
  person,
  people,
  onSelect,
  queue,
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
          person_id: person.id,
          limit: 20,
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
    void api
      .normalizationDecisions()
      .then((result) => {
        if (!cancelled) setDecisions([...result.decisions].reverse());
      })
      .catch((cause: unknown) => {
        if (!cancelled) setReviewError(cause instanceof Error ? cause.message : '机构映射加载失败');
      })
      .finally(() => {
        if (!cancelled) setReviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [person?.id]);

  const decideNormalization = useCallback(
    async (item: NormalizationDecisionT, decision: 'confirmed' | 'rejected') => {
      if (decision === 'rejected') {
        const message =
          item.kind === 'facility'
            ? '拒绝后，这些机构原文将保持未归一。确认拒绝吗？'
            : '拒绝后，这些文档不会归入同一次就诊。确认拒绝吗？';
        if (!window.confirm(message)) return;
      }
      setReviewAction(item.id);
      setReviewError(null);
      try {
        const result = await api.confirmNormalization(item.id, decision, uuidv7());
        setDecisions((current) => current.map((entry) => (entry.id === item.id ? result.decision : entry)));
      } catch (cause) {
        setReviewError(cause instanceof Error ? cause.message : '机构映射提交失败');
      } finally {
        setReviewAction(null);
      }
    },
    [],
  );

  const acknowledgePersonCheck = useCallback(async (doc: Doc) => {
    const reason = window.prompt('请填写确认理由', '已核对原件，档案归属无误');
    if (!reason?.trim()) return;
    setDocumentAction(true);
    setError(null);
    try {
      const result = await api.acknowledgePersonCheck(doc.id, reason.trim(), uuidv7());
      setDocs((current) =>
        current.map((item) =>
          item.id === doc.id ? { ...item, person_check_ack_at: result.person_check_ack_at } : item,
        ),
      );
      setViewer((current) =>
        current?.doc.id === doc.id
          ? { ...current, doc: { ...current.doc, person_check_ack_at: result.person_check_ack_at } }
          : current,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '归属确认失败');
    } finally {
      setDocumentAction(false);
    }
  }, []);

  const toggleArchive = useCallback(
    async (doc: Doc) => {
      const archived = doc.archived_at === null;
      const reason = window.prompt(
        archived ? '请填写归档理由' : '请填写恢复理由',
        archived ? '不再显示在日常档案中' : '恢复到日常档案',
      );
      if (!reason?.trim()) return;
      setDocumentAction(true);
      setError(null);
      try {
        const result = await api.archiveDocument(doc.id, archived, reason.trim(), uuidv7());
        setDocs((current) =>
          showArchived
            ? current.map((item) => (item.id === doc.id ? { ...item, archived_at: result.archived_at } : item))
            : current.filter((item) => item.id !== doc.id),
        );
        setViewer(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '文档归档操作失败');
      } finally {
        setDocumentAction(false);
      }
    },
    [showArchived],
  );

  const reassignDocument = useCallback(
    async (doc: Doc) => {
      if (!person) return;
      const targets = people.filter((item) => item.id !== doc.person_id);
      if (targets.length === 0) {
        setError('没有可接收这份文档的其他家庭成员');
        return;
      }
      const selectedIndex = window.prompt(
        `请选择目标档案编号：\n${targets.map((item, index) => `${index + 1}. ${item.display_name}`).join('\n')}`,
        '1',
      );
      if (selectedIndex === null) return;
      const target = targets[Number(selectedIndex) - 1];
      if (!target) {
        setError('目标档案编号无效');
        return;
      }
      const reason = window.prompt('请填写纠正理由', '核对原件后确认归属错误');
      if (!reason?.trim()) return;
      if (
        !window.confirm(
          `确认把这份文档从 ${person.display_name} 调整到 ${target.display_name}？原件不会移动或删除。`,
        )
      )
        return;
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
    },
    [people, person],
  );

  const [viewerRotation, setViewerRotation] = useState(0);

  useEffect(() => {
    setViewerRotation(0);
  }, [viewer?.doc.id, viewer?.page]);

  useEffect(() => {
    if (!viewer) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setViewer(null);
      if (event.key === 'ArrowLeft') {
        setViewer((current) => (current ? { ...current, page: Math.max(1, current.page - 1) } : null));
      }
      if (event.key === 'ArrowRight') {
        setViewer((current) =>
          current ? { ...current, page: Math.min(current.doc.page_count, current.page + 1) } : null,
        );
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [viewer?.doc.id]);

  if (!person) {
    return (
      <EmptyState
        variant="card"
        icon={<Archive size={32} />}
        title="请先选择档案"
        description="选择一位家庭成员后即可浏览记录。"
      />
    );
  }

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
    <div className="space-y-6" data-testid="browse">
      {/* Page Header */}
      <PageHeader
        eyebrow="健康档案库"
        title={`${person.display_name} 的档案`}
        description={
          docs.length > 0
            ? `已加载 ${docs.length} 份记录，按采集日期整理。`
            : '按时间浏览已安全归档的医疗记录。'
        }
        action={
          <div className="flex items-center gap-2">
            <Button
              variant={showArchived ? 'soft' : 'outline'}
              size="sm"
              onClick={() => setShowArchived((v) => !v)}
              iconLeft={<Archive size={14} />}
              className={cn('rounded-xl', showArchived ? 'font-semibold' : '')}
            >
              {showArchived ? '含已归档' : '查看已归档'}
            </Button>
            <span className="w-8 h-8 rounded-full bg-brand-500 text-white font-bold text-xs flex items-center justify-center shadow-xs">
              {person.display_name.slice(0, 1)}
            </span>
          </div>
        }
      />

      {/* Person Switcher Row */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar" aria-label="选择家庭成员">
        {people.map((item) => {
          const isCurrent = item.id === person.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item)}
              className={cn(
                'inline-flex items-center gap-2 min-h-[40px] px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all duration-150 cursor-pointer border',
                isCurrent
                  ? 'bg-brand-500 border-brand-600 text-white shadow-xs'
                  : 'bg-white hover:bg-brand-50/50 border-line text-ink-secondary hover:text-ink',
              )}
            >
              <span
                className={cn(
                  'w-5 h-5 rounded-md flex items-center justify-center font-bold text-[10px]',
                  isCurrent ? 'bg-white/20 text-white' : 'bg-brand-50 text-brand-700',
                )}
              >
                {item.display_name.slice(0, 1)}
              </span>
              <span>{item.display_name}</span>
            </button>
          );
        })}
      </div>

      {/* Facility Normalization Review */}
      {(reviewLoading || facilityDecisions.length > 0) && (
        <Card className="space-y-4" data-testid="facility-review">
          <div className="flex items-center justify-between pb-2 border-b border-line/60">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
                <Building2 size={18} />
              </div>
              <div>
                <h2 className="text-base font-bold text-ink">机构名称审核</h2>
                <p className="text-xs text-muted">AI 只提出映射建议；确认后才会成为可回放的人工决定。</p>
              </div>
            </div>
            {reviewLoading && <LoaderCircle className="animate-spin text-brand-600" size={18} aria-label="加载中" />}
          </div>

          <div className="space-y-3">
            {facilityDecisions.map((item) => {
              const parsed = FacilityProposal.safeParse(item.proposal);
              if (!parsed.success) {
                return (
                  <div key={item.id} className="p-3 rounded-xl bg-danger-bg border border-danger-border text-xs text-danger-text flex items-center gap-2">
                    <AlertTriangle size={16} />
                    <span>这条机构建议的数据格式无效，需要管理员检查。</span>
                  </div>
                );
              }
              const proposal = parsed.data;
              const busy = reviewAction === item.id;
              return (
                <div
                  key={item.id}
                  data-testid={`facility-decision-${item.id}`}
                  className="p-4 rounded-xl border border-line bg-surface-subtle/50 hover:bg-white space-y-2.5 transition-all"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm font-bold text-ink">{proposal.facility.name}</strong>
                    <NormalizationStateBadge state={item.state} />
                  </div>

                  <p className="text-xs text-ink-secondary">
                    <span className="text-muted">原文：</span>
                    {proposal.matched_raw_names.join('、')}
                  </p>

                  <p className="text-xs text-muted leading-relaxed">{proposal.reason}</p>

                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted pt-1">
                    {proposal.facility.city && (
                      <span className="inline-flex items-center gap-1">
                        <MapPin size={12} />
                        {proposal.facility.city}
                      </span>
                    )}
                    {proposal.facility.level && <span>{proposal.facility.level}</span>}
                    <span className="px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 font-medium text-[10px]">
                      置信度 {Math.round(proposal.confidence * 100)}%
                    </span>
                  </div>

                  {item.state === 'proposed' && (
                    <div className="flex items-center justify-end gap-2 pt-2 border-t border-line/50">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void decideNormalization(item, 'rejected')}
                        iconLeft={<X size={14} />}
                      >
                        拒绝
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        loading={busy}
                        onClick={() => void decideNormalization(item, 'confirmed')}
                        iconLeft={!busy ? <Check size={14} /> : undefined}
                      >
                        确认
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Encounter Grouping Review */}
      {encounterDecisions.length > 0 && (
        <Card className="space-y-4" data-testid="encounter-review">
          <div className="flex items-center gap-3 pb-2 border-b border-line/60">
            <div className="w-9 h-9 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
              <CalendarDays size={18} />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">就诊归组建议</h2>
              <p className="text-xs text-muted">确认后才会把两份文档归入同一次就诊。</p>
            </div>
          </div>

          <div className="space-y-3">
            {encounterDecisions.map((item) => {
              const parsed = EncounterProposal.safeParse(item.proposal);
              if (!parsed.success) return null;
              const proposal = parsed.data;
              const busy = reviewAction === item.id;
              return (
                <div
                  key={item.id}
                  data-testid={`encounter-decision-${item.id}`}
                  className="p-4 rounded-xl border border-line bg-surface-subtle/50 hover:bg-white space-y-2.5 transition-all"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm font-bold text-ink">
                      {displayDate(proposal.occurred_on)} 的就诊
                    </strong>
                    <div className="flex items-center gap-1.5">
                      {proposal.grouping_basis === 'capture_date_degraded' && (
                        <span className="px-1.5 py-0.5 rounded bg-warning-bg text-warning-text border border-warning-border text-[10px] font-semibold">
                          判据较弱
                        </span>
                      )}
                      <NormalizationStateBadge state={item.state} />
                    </div>
                  </div>

                  <p className="text-xs text-ink-secondary">
                    <span className="text-muted">文档：</span>
                    {proposal.document_short_ids.join('、')}
                  </p>

                  <p className="text-xs text-muted leading-relaxed">{proposal.reason}</p>

                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted pt-1">
                    <span>{ENCOUNTER_TYPE_LABEL[proposal.encounter_type] ?? proposal.encounter_type}</span>
                    <span className="px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 font-medium text-[10px]">
                      置信度 {Math.round(proposal.confidence * 100)}%
                    </span>
                  </div>

                  {item.state === 'proposed' && (
                    <div className="flex items-center justify-end gap-2 pt-2 border-t border-line/50">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void decideNormalization(item, 'rejected')}
                        iconLeft={<X size={14} />}
                      >
                        拒绝
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        loading={busy}
                        onClick={() => void decideNormalization(item, 'confirmed')}
                        iconLeft={!busy ? <Check size={14} /> : undefined}
                      >
                        确认归组
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {reviewError && (
        <Alert variant="danger">
          <span>{reviewError}</span>
        </Alert>
      )}

      {/* Pending uploads for current person */}
      {queuedForPerson.length > 0 && (
        <Card className="space-y-3 bg-brand-50/50 border-brand-200" data-testid="browse-pending">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-brand-500 text-white flex items-center justify-center shrink-0">
              <UploadCloud size={18} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-brand-900">待上传({queuedForPerson.length})</h3>
              <p className="text-xs text-brand-700">这些文件已安全保存在当前设备。</p>
            </div>
          </div>
          <ul className="space-y-1.5 pt-1">
            {queuedForPerson.map((q) => (
              <li
                key={q.client_document_id}
                className="flex items-center gap-2 text-xs text-brand-800 bg-white/80 px-3 py-2 rounded-lg border border-brand-200/60"
              >
                <Clock3 size={13} className="text-brand-600 shrink-0" />
                <span>
                  {new Date(q.captured_at).toLocaleString()} · {q.page_count} 页 · {q.state}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Timeline of documents */}
      {[...groups.entries()].map(([date, items]) => (
        <div key={date} className="space-y-3" data-testid={`day-${date}`}>
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <CalendarDays size={16} className="text-brand-600" />
              <h3 className="text-sm md:text-base font-bold text-ink tracking-tight">
                {displayDate(date)}
              </h3>
            </div>
            <span className="text-xs font-semibold text-muted bg-surface-subtle px-2.5 py-0.5 rounded-full border border-line/60">
              {items.length} 份
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {items.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setViewer({ doc: d, page: 1 })}
                aria-label={`查看${d.facility_name ?? d.original_filename ?? '医疗记录'}大图`}
                data-testid={`doc-${d.short_id}`}
                className={cn(
                  'group flex items-start gap-3.5 p-3.5 rounded-2xl border text-left transition-all duration-200 cursor-pointer',
                  'bg-white/95 hover:bg-white border-line hover:border-brand-300 shadow-xs hover:shadow-md active:scale-[0.99]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1',
                )}
              >
                {/* Thumbnail */}
                <div className="relative w-20 h-24 sm:w-24 sm:h-28 rounded-xl bg-surface-subtle border border-line/70 overflow-hidden shrink-0 flex items-center justify-center shadow-2xs group-hover:shadow-xs transition-all">
                  {d.first_page && d.first_page.mime_type !== 'application/pdf' ? (
                    <img
                      loading="lazy"
                      src={`${derivativeUrl(d.id, 1, 'thumb')}?access_token=${encodeURIComponent(auth.get() ?? '')}`}
                      alt={`${DOC_TYPE_LABEL[d.doc_type] ?? '医疗记录'}缩略图`}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                      data-testid={`thumb-${d.short_id}`}
                    />
                  ) : (
                    <div
                      className="flex flex-col items-center justify-center gap-1 text-muted"
                      data-testid={`placeholder-${d.short_id}`}
                    >
                      <FileText size={28} className="text-brand-600" />
                      <strong className="text-[10px] tracking-wider text-muted uppercase font-bold">PDF</strong>
                    </div>
                  )}
                  <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded-md bg-black/60 backdrop-blur-xs text-white text-[10px] font-bold">
                    {d.page_count} 页
                  </span>
                </div>

                {/* Card Body */}
                <div className="flex-1 min-w-0 flex flex-col justify-between self-stretch py-0.5 space-y-1.5">
                  <div className="space-y-1">
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-brand-700 bg-brand-50 px-2 py-0.5 rounded-md border border-brand-200/60">
                      <FileImage size={12} /> {DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type}
                    </span>
                    <strong className="text-sm font-bold text-ink line-clamp-1 group-hover:text-brand-700 transition-colors">
                      {d.facility_name ?? d.original_filename ?? '医疗记录'}
                    </strong>
                  </div>

                  <div className="space-y-1 text-xs text-muted">
                    {d.facility_name && (
                      <div className="flex items-center gap-1 truncate">
                        <MapPin size={11} className="shrink-0" />
                        <span className="truncate">{d.facility_name}</span>
                      </div>
                    )}
                    <div className="text-[11px]">
                      {new Date(d.captured_at).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    {d.person_check === 'mismatch' && !d.person_check_ack_at && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-warning-bg text-warning-text border border-warning-border text-[10px] font-semibold">
                        <AlertTriangle size={11} /> 待核对归属
                      </span>
                    )}
                    {d.archived_at && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface-subtle text-muted border border-line text-[10px] font-medium">
                        <Archive size={11} /> 已归档
                      </span>
                    )}
                  </div>
                </div>

                <ChevronRight className="text-muted/60 group-hover:text-brand-600 group-hover:translate-x-0.5 transition-all self-center shrink-0" size={18} />
              </button>
            ))}
          </div>
        </div>
      ))}

      {error && (
        <Alert variant="danger">
          <span>{error}</span>
        </Alert>
      )}

      {cursor && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            size="md"
            onClick={() => void load(false)}
            disabled={loading}
            loading={loading}
            data-testid="load-more"
            className="rounded-xl px-8"
          >
            加载更多
          </Button>
        </div>
      )}

      {loading && docs.length === 0 && (
        <div className="flex flex-col items-center justify-center p-12 space-y-3 bg-white/95 rounded-3xl border border-line shadow-soft">
          <LoaderCircle className="animate-spin text-brand-600" size={32} />
          <span className="text-sm font-medium text-muted">正在加载档案…</span>
        </div>
      )}

      {docs.length === 0 && !loading && (
        <EmptyState
          variant="card"
          icon={<Archive size={32} />}
          title="还没有已上传的文档"
          description="切换到「采集」，拍照或导入第一份医疗记录。"
          data-testid="browse-empty"
        />
      )}

      {/* Full-Size Document Viewer Modal */}
      {viewer &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="病历大图预览"
            data-testid="document-viewer"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setViewer(null);
            }}
            className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-md text-white animate-in fade-in duration-150 select-none"
          >
            {/* Viewer Toolbar */}
            <header className="flex items-center justify-between px-4 py-3 sm:px-6 sm:py-4 bg-black/40 border-b border-white/10 backdrop-blur-xs">
              <div className="flex items-center gap-3 min-w-0 pr-4">
                <span className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/10 text-white/90 text-xs font-semibold shrink-0">
                  <Maximize2 size={13} /> 大图预览
                </span>
                <strong className="text-sm sm:text-base font-bold text-white truncate">
                  {viewer.doc.facility_name ?? viewer.doc.original_filename ?? '医疗记录'}
                </strong>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {viewer.doc.person_check === 'mismatch' && !viewer.doc.person_check_ack_at && (
                  <>
                    <button
                      type="button"
                      onClick={() => void acknowledgePersonCheck(viewer.doc)}
                      disabled={documentAction}
                      aria-label="确认档案归属无误"
                      className="p-2 rounded-xl bg-white/10 hover:bg-brand-500 text-white transition-colors cursor-pointer"
                      title="确认档案归属无误"
                    >
                      <ShieldCheck size={19} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void reassignDocument(viewer.doc)}
                      disabled={documentAction}
                      aria-label="纠正档案归属"
                      className="p-2 rounded-xl bg-white/10 hover:bg-warning text-white transition-colors cursor-pointer"
                      title="纠正档案归属"
                    >
                      <UserRoundCog size={19} />
                    </button>
                  </>
                )}

                <button
                  type="button"
                  onClick={() => setViewerRotation((r) => (r - 90 + 360) % 360)}
                  aria-label="向左旋转90度"
                  className="p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
                  title="向左旋转90度"
                >
                  <RotateCcw size={19} />
                </button>

                <button
                  type="button"
                  onClick={() => setViewerRotation((r) => (r + 90) % 360)}
                  aria-label="向右旋转90度"
                  className="p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
                  title="向右旋转90度"
                >
                  <RotateCw size={19} />
                </button>

                <button
                  type="button"
                  onClick={() => void toggleArchive(viewer.doc)}
                  disabled={documentAction}
                  aria-label={viewer.doc.archived_at ? '恢复文档' : '归档文档'}
                  className="p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
                  title={viewer.doc.archived_at ? '恢复文档' : '归档文档'}
                >
                  {viewer.doc.archived_at ? <RotateCcw size={19} /> : <Trash2 size={19} />}
                </button>

                <button
                  type="button"
                  onClick={() => setViewer(null)}
                  aria-label="关闭大图"
                  data-testid="viewer-close"
                  autoFocus
                  className="p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
                >
                  <X size={22} />
                </button>
              </div>
            </header>

            {/* Viewer Stage */}
            <div className="flex-1 relative flex items-center justify-center p-4 min-h-0 overflow-hidden">
              <button
                type="button"
                onClick={() => setViewer((cur) => (cur ? { ...cur, page: Math.max(1, cur.page - 1) } : null))}
                disabled={viewer.page === 1}
                aria-label="上一页"
                data-testid="viewer-previous"
                className={cn(
                  'absolute left-4 z-10 p-3 rounded-2xl bg-black/60 hover:bg-black/80 text-white backdrop-blur-xs transition-all cursor-pointer shadow-lg',
                  'disabled:opacity-30 disabled:pointer-events-none',
                )}
              >
                <ChevronLeft size={28} />
              </button>

              <div
                className="w-full h-full flex items-center justify-center"
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) setViewer(null);
                }}
              >
                {viewer.doc.first_page?.mime_type === 'application/pdf' ? (
                  <div className="flex flex-col items-center justify-center gap-3 p-8 rounded-3xl bg-white/10 text-white max-w-sm text-center">
                    <FileText size={48} className="text-brand-300" />
                    <strong className="text-lg font-bold">PDF 大图预览即将支持</strong>
                    <span className="text-xs text-white/70">当前可确认文件已经安全归档。</span>
                  </div>
                ) : (
                  <img
                    key={`${viewer.doc.id}-${viewer.page}`}
                    src={`${derivativeUrl(viewer.doc.id, viewer.page, 'preview')}?access_token=${encodeURIComponent(auth.get() ?? '')}`}
                    alt={`${DOC_TYPE_LABEL[viewer.doc.doc_type] ?? '医疗记录'}第 ${viewer.page} 页`}
                    data-testid="viewer-image"
                    style={{ transform: viewerRotation ? `rotate(${viewerRotation}deg)` : undefined }}
                    className="max-w-full max-h-full object-contain rounded-lg shadow-2xl transition-transform duration-200 animate-in zoom-in-95"
                  />
                )}
              </div>

              <button
                type="button"
                onClick={() =>
                  setViewer((cur) =>
                    cur ? { ...cur, page: Math.min(cur.doc.page_count, cur.page + 1) } : null,
                  )
                }
                disabled={viewer.page === viewer.doc.page_count}
                aria-label="下一页"
                data-testid="viewer-next"
                className={cn(
                  'absolute right-4 z-10 p-3 rounded-2xl bg-black/60 hover:bg-black/80 text-white backdrop-blur-xs transition-all cursor-pointer shadow-lg',
                  'disabled:opacity-30 disabled:pointer-events-none',
                )}
              >
                <ChevronRight size={28} />
              </button>
            </div>

            {/* Viewer Footer */}
            <footer className="flex items-center justify-between px-4 py-3 sm:px-6 sm:py-3.5 bg-black/40 border-t border-white/10 text-xs text-white/80">
              <span>{displayDate(viewer.doc.capture_date)}</span>
              <strong className="text-white font-bold bg-white/10 px-3 py-1 rounded-full">
                第 {viewer.page} / {viewer.doc.page_count} 页
              </strong>
              <span className="hidden sm:inline">Esc 关闭 · 方向键翻页</span>
            </footer>
          </div>,
          document.body,
        )}
    </div>
  );
}
