import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContextAnswerInputT, ContextQuestionT } from '@amr/contracts';
import {
  Camera, Check, CircleAlert, Clock3, LoaderCircle, Mic, RefreshCw, Save,
} from 'lucide-react';
import {
  contextAnswersForSession, contextMediaForSession, getContextSession,
  type ContextLocalAnswer, type ContextLocalMedia, type ContextLocalSession,
} from '../../offline/db.js';
import {
  attachContextMedia, availableContextTemplates, configureContextSession,
  ensureSameDayContextPlaceholder, requestContextCompletion, retryContextConflict,
  saveContextAnswer, syncContextSession,
} from '../../offline/context.js';
import { api } from '../../api/client.js';
import { Alert } from '../../ui/Alert.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { Dialog } from '../../ui/Dialog.js';
import { Field } from '../../ui/Field.js';
import { Input } from '../../ui/Input.js';
import { cn } from '../../ui/cn.js';

const TEMPLATE_LABELS: Record<string, string> = {
  'lab-report': '化验单',
  'imaging-report': '影像 / 病理 / 心电报告',
  prescription: '处方 / 输液单',
  'checkup-report': '体检报告',
  generic: '其他医疗记录',
};

const STAGE_LABELS = { onsite: '现场补充', same_day: '当天补录', anytime: '随时记录' } as const;
const SYNC_LABELS: Record<ContextLocalSession['sync_state'], string> = {
  needs_template: '待选择模板', draft: '本机草稿', pending: '待同步', syncing: '同步中',
  conflict: '需要合并', synced: '已同步', completed: '已完成',
};

function skippedAnswer(question: ContextQuestionT): ContextAnswerInputT {
  return {
    question_key: question.key, answer_type: question.answer_type,
    value: null, skipped: true, answered_at: new Date().toISOString(),
  };
}

function textAnswer(question: ContextQuestionT, value: string): ContextAnswerInputT {
  return {
    question_key: question.key, answer_type: 'text', value,
    skipped: false, answered_at: new Date().toISOString(),
  };
}

function QuestionEditor({
  question, current, media, mediaUrl, disabled, onSave, onAttach, onError,
}: {
  question: ContextQuestionT;
  current?: ContextLocalAnswer;
  media?: ContextLocalMedia;
  mediaUrl?: string;
  disabled: boolean;
  onSave: (answer: ContextAnswerInputT) => Promise<void>;
  onAttach: (question: ContextQuestionT, blob: Blob) => Promise<void>;
  onError: (message: string) => void;
}): JSX.Element {
  const answer = current?.answer;
  const [text, setText] = useState<string>(
    answer && !answer.skipped && answer.answer_type === 'text' && typeof answer.value === 'string'
      ? answer.value : '',
  );
  const [number, setNumber] = useState<string>(
    answer && !answer.skipped && answer.answer_type === 'number' && typeof answer.value === 'number'
      ? String(answer.value) : '',
  );
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    setText(answer && !answer.skipped && answer.answer_type === 'text' && typeof answer.value === 'string'
      ? answer.value : '');
    setNumber(answer && !answer.skipped && answer.answer_type === 'number' && typeof answer.value === 'number'
      ? String(answer.value) : '');
  }, [answer]);

  useEffect(() => () => {
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const selected = answer && !answer.skipped && answer.answer_type === 'choice'
      && typeof answer.value === 'string' ? answer.value : null;
  const selectedMany = new Set(
    answer && !answer.skipped && answer.answer_type === 'multi_choice' && Array.isArray(answer.value)
      ? answer.value.filter((value): value is string => typeof value === 'string') : [],
  );

  async function toggleRecording(): Promise<void> {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const preferred = ['audio/mp4', 'audio/webm'].find((mime) => MediaRecorder.isTypeSupported(mime));
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const mime = recorder.mimeType.split(';')[0] || preferred || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: mime });
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        if (blob.size > 0) void onAttach(question, blob).catch((error: unknown) => {
          onError(error instanceof Error ? error.message : String(error));
        });
      };
      recorder.start();
      setRecording(true);
    } catch {
      onError('无法使用麦克风。可以直接在下方输入文字，或稍后在浏览器设置中允许麦克风。');
    }
  }

  const answerControl = question.answer_type === 'choice' ? (
    <div className="flex flex-wrap gap-2">
      {question.options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant={selected === option.value ? 'primary' : 'outline'}
          disabled={disabled}
          onClick={() => onSave({
            question_key: question.key, answer_type: 'choice', value: option.value,
            skipped: false, answered_at: new Date().toISOString(),
          })}
        >
          {option.label}
        </Button>
      ))}
    </div>
  ) : question.answer_type === 'multi_choice' ? (
    <div className="grid gap-2 sm:grid-cols-2">
      {question.options.map((option) => (
        <label key={option.value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm">
          <input
            type="checkbox"
            checked={selectedMany.has(option.value)}
            disabled={disabled}
            onChange={() => {
              const next = new Set(selectedMany);
              if (next.has(option.value)) next.delete(option.value); else next.add(option.value);
              void onSave(next.size > 0 ? {
                question_key: question.key, answer_type: 'multi_choice', value: [...next],
                skipped: false, answered_at: new Date().toISOString(),
              } : skippedAnswer(question));
            }}
          />
          {option.label}
        </label>
      ))}
    </div>
  ) : question.answer_type === 'number' ? (
    <Input
      aria-label={question.text}
      type="number"
      min={question.number_min ?? undefined}
      max={question.number_max ?? undefined}
      value={number}
      disabled={disabled}
      onChange={(event) => setNumber(event.target.value)}
      onBlur={() => {
        if (number.trim() === '') return;
        const value = Number(number);
        if (Number.isFinite(value)) void onSave({
          question_key: question.key, answer_type: 'number', value,
          skipped: false, answered_at: new Date().toISOString(),
        });
      }}
    />
  ) : question.answer_type === 'date' || question.answer_type === 'datetime' ? (
    <Input
      aria-label={question.text}
      type={question.answer_type === 'date' ? 'date' : 'datetime-local'}
      value={answer && !answer.skipped && answer.answer_type === question.answer_type
        && typeof answer.value === 'string'
        ? (question.answer_type === 'datetime' ? answer.value.slice(0, 16) : answer.value) : ''}
      disabled={disabled}
      onChange={(event) => {
        if (!event.target.value) return;
        if (question.answer_type === 'date') {
          void onSave({
            question_key: question.key, answer_type: 'date', value: event.target.value,
            skipped: false, answered_at: new Date().toISOString(),
          });
        } else {
          void onSave({
            question_key: question.key, answer_type: 'datetime',
            value: new Date(event.target.value).toISOString(),
            skipped: false, answered_at: new Date().toISOString(),
          });
        }
      }}
    />
  ) : question.answer_type === 'photo' ? (
    <div className="space-y-3">
      {mediaUrl && <img src={mediaUrl} alt="情境照片预览" className="max-h-52 rounded-xl border border-line object-contain" />}
      <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-line bg-white px-4 py-2 text-sm font-medium">
        <Camera size={17} /> {media ? '重新选择照片' : '拍照或选择照片'}
        <input
          className="sr-only"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onAttach(question, file);
            event.target.value = '';
          }}
        />
      </label>
    </div>
  ) : question.answer_type === 'audio' ? (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={recording ? 'danger' : 'outline'}
          iconLeft={recording ? <LoaderCircle className="animate-spin" size={16} /> : <Mic size={16} />}
          disabled={disabled}
          onClick={() => void toggleRecording()}
        >
          {recording ? '结束录音' : media ? '重新录音' : '录音'}
        </Button>
        {media && <Badge variant={media.state === 'failed' ? 'danger' : 'info'}>{media.state === 'finalized' ? '录音已上传' : '录音保存在本机'}</Badge>}
      </div>
      {mediaUrl && <audio controls src={mediaUrl} className="w-full" data-testid={`context-audio-${question.key}`} />}
      {question.allow_text_fallback && (
        <Field label="也可以直接输入文字" hint="录音不可用时，文字入口始终保留。">
          <textarea
            aria-label={`${question.text}文字回答`}
            rows={3}
            value={text}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onBlur={() => {
              if (text.trim()) void onSave(textAnswer(question, text.trim()));
            }}
            className="w-full rounded-xl border border-line px-3.5 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
          />
        </Field>
      )}
    </div>
  ) : (
    <textarea
      aria-label={question.text}
      rows={3}
      value={text}
      disabled={disabled}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text.trim()) void onSave(textAnswer(question, text.trim()));
      }}
      className="w-full rounded-xl border border-line px-3.5 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
    />
  );

  return (
    <Card className="space-y-3" data-testid={`context-question-${question.key}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-ink">{question.text}</p>
          <p className="mt-1 text-xs text-muted">可以跳过，稍后仍可补录。</p>
        </div>
        {answer && <Badge variant={answer.skipped ? 'neutral' : 'success'}>{answer.skipped ? '已跳过' : '已保存'}</Badge>}
      </div>
      {answerControl}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onSave(skippedAnswer(question))}>跳过此题</Button>
      </div>
    </Card>
  );
}

export function ContextDialog({
  sessionId, onClose, onChanged,
}: {
  sessionId: string;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}): JSX.Element {
  const [session, setSession] = useState<ContextLocalSession | null>(null);
  const [answers, setAnswers] = useState<ContextLocalAnswer[]>([]);
  const [media, setMedia] = useState<ContextLocalMedia[]>([]);
  const [templates, setTemplates] = useState<Awaited<ReturnType<typeof availableContextTemplates>>>([]);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const nextSession = await getContextSession(sessionId);
    if (!nextSession) throw new Error('情境记录不存在');
    const [nextAnswers, nextMedia, nextTemplates] = await Promise.all([
      contextAnswersForSession(sessionId), contextMediaForSession(sessionId),
      availableContextTemplates(nextSession.person_id, nextSession.stage),
    ]);
    setSession(nextSession);
    setAnswers(nextAnswers);
    setMedia(nextMedia);
    setTemplates(nextTemplates);
  }, [sessionId]);

  useEffect(() => { void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }, [load]);

  useEffect(() => {
    const localUrls: string[] = [];
    const next: Record<string, string> = {};
    for (const item of media) {
      const url = URL.createObjectURL(item.blob);
      localUrls.push(url);
      next[item.question_key] = url;
    }
    setMediaUrls(next);
    const remoteAnswers = answers.filter((item) => !item.answer.skipped
      && (item.answer.answer_type === 'audio' || item.answer.answer_type === 'photo')
      && !next[item.question_key]);
    void Promise.all(remoteAnswers.map(async (item) => {
      if (item.answer.skipped || (item.answer.answer_type !== 'audio' && item.answer.answer_type !== 'photo')) return;
      try {
        const value = item.answer.value;
        if (typeof value !== 'object' || value === null || !('upload_id' in value)
            || typeof value.upload_id !== 'string') return;
        const remote = await api.contextUpload(value.upload_id);
        setMediaUrls((current) => ({ ...current, [item.question_key]: remote.url }));
      } catch { /* 原件缺失时保留事实与诚实状态，不阻止其他答案。 */ }
    }));
    return () => localUrls.forEach((url) => URL.revokeObjectURL(url));
  }, [answers, media]);

  const answerMap = useMemo(() => new Map(answers.map((item) => [item.question_key, item])), [answers]);
  const mediaMap = useMemo(() => new Map(media.map((item) => [item.question_key, item])), [media]);

  async function configure(templateId: string, version: number): Promise<void> {
    setBusy(true); setError(null);
    try {
      await configureContextSession(sessionId, templateId, version);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  async function save(answer: ContextAnswerInputT): Promise<void> {
    setError(null); setMessage(null);
    try {
      await saveContextAnswer(sessionId, answer);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function attach(question: ContextQuestionT, blob: Blob): Promise<void> {
    setError(null);
    await attachContextMedia(sessionId, question, blob);
    await load();
  }

  async function saveAndClose(): Promise<void> {
    setBusy(true); setError(null);
    try {
      const result = await syncContextSession(sessionId);
      await onChanged();
      if (result.sync_state === 'conflict') {
        setError('服务器上已有更新。本机草稿仍在，请先处理冲突。');
        await load();
        return;
      }
      onClose();
    } finally { setBusy(false); }
  }

  async function complete(): Promise<void> {
    setBusy(true); setError(null);
    try {
      await requestContextCompletion(sessionId);
      const current = await getContextSession(sessionId);
      if (current) await ensureSameDayContextPlaceholder(current);
      const result = await syncContextSession(sessionId);
      setMessage(result.sync_state === 'completed' ? '情境记录已完成并同步。' : '已保存在本机，联网后会自动同步。');
      await load();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  async function resolveConflict(): Promise<void> {
    setBusy(true); setError(null);
    try {
      await retryContextConflict(sessionId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      closeOnBackdropClick={false}
      size="xl"
      title={session ? `${session.person_display_name} · ${STAGE_LABELS[session.stage]}` : '情境记录'}
      description="记录影像里看不到、过后容易忘记的信息。所有问题都可以跳过。"
      icon={<Clock3 size={22} />}
    >
      <div className="space-y-4" data-testid="context-dialog">
        {error && <Alert variant="danger"><CircleAlert size={17} /><span>{error}</span></Alert>}
        {message && <Alert variant="success"><Check size={17} /><span>{message}</span></Alert>}
        {!session ? (
          <div className="flex justify-center py-12"><LoaderCircle className="animate-spin text-brand-600" /></div>
        ) : session.sync_state === 'needs_template' ? (
          <div className="space-y-4" data-testid="context-template-picker">
            {templates.length === 0 ? (
              <Alert variant="warning">
                当前没有可用的离线模板。文档会继续上传；联网刷新模板后可从“数据”页补录。
              </Alert>
            ) : (
              <>
                <p className="text-sm text-muted">请选择这份记录的类型，问题会保存在本机并冻结版本。</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {templates.map((template) => (
                    <Button
                      key={`${template.template_id}-${template.version}`}
                      variant="outline"
                      className="justify-start"
                      disabled={busy}
                      data-testid={`context-template-${template.template_id}`}
                      onClick={() => void configure(template.template_id, template.version)}
                    >
                      {TEMPLATE_LABELS[template.template_id] ?? template.template_id}
                    </Button>
                  ))}
                </div>
              </>
            )}
            <div className="flex justify-end"><Button variant="ghost" onClick={onClose}>跳过，稍后补录</Button></div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={session.sync_state === 'conflict' ? 'danger' : session.sync_state === 'completed' ? 'success' : 'info'}>
                {SYNC_LABELS[session.sync_state]}
              </Badge>
              <Badge variant="neutral">{TEMPLATE_LABELS[session.template_id ?? ''] ?? session.template_id} · v{session.template_version}</Badge>
              {!navigator.onLine && <Badge variant="warning">离线</Badge>}
            </div>
            {session.sync_state === 'conflict' && (
              <Alert variant="warning">
                <span className="flex-1">服务器版本发生变化，本机草稿没有丢失。</span>
                <Button size="sm" variant="outline" iconLeft={<RefreshCw size={14} />} loading={busy} onClick={() => void resolveConflict()}>
                  基于最新版本重试
                </Button>
              </Alert>
            )}
            <div className="space-y-3">
              {session.question_snapshot.map((question) => (
                <QuestionEditor
                  key={question.key}
                  question={question}
                  current={answerMap.get(question.key)}
                  media={mediaMap.get(question.key)}
                  mediaUrl={mediaUrls[question.key]}
                  disabled={busy || session.sync_state === 'completed'}
                  onSave={save}
                  onAttach={attach}
                  onError={setError}
                />
              ))}
            </div>
            <div className={cn('sticky bottom-0 flex flex-col-reverse gap-2 border-t border-line bg-white/95 pt-4 sm:flex-row sm:justify-end')}>
              <Button variant="ghost" onClick={onClose}>关闭</Button>
              {session.sync_state !== 'completed' && (
                <>
                  <Button variant="outline" iconLeft={<Save size={16} />} loading={busy} onClick={() => void saveAndClose()}>保存，稍后继续</Button>
                  <Button variant="primary" iconLeft={<Check size={16} />} loading={busy} onClick={() => void complete()}>完成记录</Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
