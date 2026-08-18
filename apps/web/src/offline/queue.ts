import { uuidv7 } from 'uuidv7';
import { api, ApiFailure, auth } from '../api/client.js';
import {
  allCaptures, blobsOf, deleteCaptureCompletely, getCapture, putCapture,
  type CaptureRecord,
} from './db.js';
import { checkPause } from './pause.js';

// spec m1-04 §2–§5:状态机、错误三段分类、退避、前台驱动。

type Stage = 'presign' | 'put' | 'register';
type Disposition = 'retry' | 'repres1gn' | 'terminal' | 'paused' | 'done';

const MAX_BACKOFF_MS = 5 * 60 * 1000;
const FOREGROUND_ONLY_AFTER = 12;

export interface QueueEvents {
  onChange?: () => void;
  onAuthLost?: () => void;
  onPersonUnavailable?: (personId: string) => void;
}

let running = false;
let paused = false;
let events: QueueEvents = {};
let timer: number | null = null;

export function configureQueue(e: QueueEvents): void {
  events = e;
}
export function pauseQueue(): void {
  paused = true;
}
export function resumeQueue(): void {
  paused = false;
  void tick('resume');
}

/** 全抖动退避(m1-04 §4) */
function backoffMs(attempt: number): number {
  const base = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
  return Math.floor(base * (0.5 + Math.random() / 2));
}

/** 错误分类(m1-04 §3):按阶段 + code,未列举的 4xx 一律终止,5xx 可重试。 */
function classify(stage: Stage, err: unknown): { disposition: Disposition; code: string; message: string } {
  if (err instanceof ApiFailure) {
    const { status, code, message } = err;
    if (status === 401) return { disposition: 'paused', code, message };
    if (status === 404) return { disposition: 'paused', code: 'person_unavailable', message };
    if (status === 429 || status === 408) return { disposition: 'retry', code, message };
    if (code === 'upload_incomplete' || code === 'upload_consumed') {
      return { disposition: 'repres1gn', code, message };
    }
    // 500 internal_error:服务端已判定存储不一致,重试不会自愈(m1-04 §3)
    if (code === 'internal_error') return { disposition: 'terminal', code, message };
    if (status >= 500) return { disposition: 'retry', code, message };
    return { disposition: 'terminal', code, message };        // 未列举的 4xx
  }
  if (err instanceof S3PutFailure) {
    if (err.status === 403) return { disposition: 'repres1gn', code: 's3_expired', message: err.message };
    if (err.status === 400) return { disposition: 'terminal', code: 's3_bad_request', message: err.message };
    if (err.status >= 500) return { disposition: 'retry', code: 's3_5xx', message: err.message };
    return { disposition: 'terminal', code: `s3_${err.status}`, message: err.message };
  }
  // 网络失败/超时
  return { disposition: 'retry', code: 'network', message: err instanceof Error ? err.message : String(err) };
}

class S3PutFailure extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function applyFailure(rec: CaptureRecord, stage: Stage, err: unknown): Promise<void> {
  const { disposition, code, message } = classify(stage, err);
  const last_error = { stage, code, message, at: new Date().toISOString() };

  if (disposition === 'paused') {
    // 不增 attempt(避免耗尽重试预算)
    await putCapture({ ...rec, state: 'pending', batch: null, last_error });
    if (code === 'person_unavailable') events.onPersonUnavailable?.(rec.person_id ?? '');
    else {
      auth.clear();
      pauseQueue();
      events.onAuthLost?.();
    }
    return;
  }
  if (disposition === 'terminal') {
    // ★ 禁止任何自动删除:本地 blob 可能是唯一副本(审核 #002 A-15)
    await putCapture({ ...rec, state: 'failed_terminal', batch: null, last_error });
    return;
  }
  if (disposition === 'repres1gn') {
    await putCapture({ ...rec, state: 'pending', batch: null, next_attempt_at: 0, last_error });
    return;
  }
  const attempt = rec.attempt + 1;
  await putCapture({
    ...rec, state: 'pending', batch: null, attempt,
    next_attempt_at: Date.now() + backoffMs(attempt), last_error,
  });
}

async function processOne(rec: CaptureRecord): Promise<void> {
  const blobs = await blobsOf(rec.client_document_id, rec.page_count);
  if (blobs.length !== rec.page_count) {
    await putCapture({
      ...rec, state: 'failed_terminal',
      last_error: { stage: 'presign', code: 'local_blob_missing', message: '本地原件缺失', at: new Date().toISOString() },
    });
    return;
  }

  // ① presign(在上传时取 —— 预签名 15 分钟、批次 24 小时过期,m1-04 §2.2)
  let batch: NonNullable<CaptureRecord['batch']>;
  try {
    await checkPause('presign');
    const res = await api.presign({
      person_id: rec.person_id,
      files: blobs.map((b) => ({
        filename: b.filename, mime_type: b.mime_type, byte_size: b.byte_size, sha256: b.sha256,
      })),
    });
    batch = {
      batch_id: res.batch_id,
      uploads: res.uploads.map((u, i) => ({
        page_no: blobs[i]!.page_no, upload_id: u.upload_id, url: u.url,
        headers: u.headers, expires_at: u.expires_at,
      })),
    };
  } catch (e) {
    await applyFailure(rec, 'presign', e);
    return;
  }

  await putCapture({ ...rec, state: 'uploading', batch });
  events.onChange?.();   // 状态进 uploading 必须让视图跟上:否则"改归属"按钮还挂在那儿(m1-99 A11)

  // ② 直传(整文件单 PUT;分片续传见 D14)
  try {
    for (const up of batch.uploads) {
      await checkPause('put');
      const b = blobs.find((x) => x.page_no === up.page_no)!;
      const res = await fetch(up.url, { method: 'PUT', headers: up.headers, body: b.blob });
      if (!res.ok) throw new S3PutFailure(res.status, `S3 PUT ${res.status}`);
    }
  } catch (e) {
    await applyFailure({ ...rec, batch }, 'put', e);
    return;
  }

  // ③ 登记
  await putCapture({ ...rec, state: 'registering', batch });
  events.onChange?.();
  try {
    await checkPause('register');
    await api.createDocument({
      person_id: rec.person_id,
      person_confirmed: true,
      confirmed_by: 'capture_ui',          // ADR-041 的 L1 载体(m1-01 §A1)
      batch_id: batch.batch_id,
      source: rec.source,
      captured_at: rec.captured_at,
      pages: batch.uploads.map((u) => {
        const b = blobs.find((x) => x.page_no === u.page_no)!;
        return {
          upload_id: u.upload_id, page_no: u.page_no, capture_order: b.capture_order,
          width: b.width, height: b.height, sha256: b.sha256, exif: b.exif,
        };
      }),
      client_document_id: rec.client_document_id,
    });
  } catch (e) {
    await applyFailure({ ...rec, batch }, 'register', e);
    return;
  }

  // 2xx ⇒ done 是瞬态:同事务删两 store(m1-04 §2.5)
  await deleteCaptureCompletely(rec.client_document_id, rec.page_count);
}

async function processDiscard(rec: CaptureRecord): Promise<void> {
  try {
    await api.discard({
      person_id: rec.person_id!,
      client_document_id: rec.client_document_id,
      discard_event_id: rec.discard_event_id ?? uuidv7(),
      captured_at: rec.captured_at,
      page_count: rec.page_count,
      reason: rec.last_error ? 'terminal_error' : 'user_discarded',
      detail: rec.last_error?.message ?? null,
    });
    await deleteCaptureCompletely(rec.client_document_id, rec.page_count);
  } catch (e) {
    // 上报失败:保留元数据与 blob,联网后补报(m1-04 §6)
    await applyFailure(rec, 'register', e);
    const again = await getCapture(rec.client_document_id);
    if (again && again.state !== 'pending_discard') {
      await putCapture({ ...again, state: 'pending_discard' });
    }
  }
}

/** 用户点"放弃"(唯一的删除触发点,m1-04 §6) */
export async function discardCapture(id: string): Promise<void> {
  const rec = await getCapture(id);
  if (!rec) return;
  const withEvent: CaptureRecord = {
    ...rec, state: 'pending_discard',
    discard_event_id: rec.discard_event_id ?? uuidv7(),   // 持久化 ⇒ 重放幂等
  };
  await putCapture(withEvent);
  events.onChange?.();
  if (navigator.onLine && rec.person_id) await processDiscard(withEvent);
  events.onChange?.();
}

export async function retryTerminal(id: string): Promise<void> {
  const rec = await getCapture(id);
  if (!rec || rec.state !== 'failed_terminal') return;
  await putCapture({ ...rec, state: 'pending', attempt: 0, next_attempt_at: 0, last_error: null });
  events.onChange?.();
  void tick('manual-retry');
}

/** 队列推进一轮。多标签由 Web Locks 串行化(m1-04 §8)。 */
export async function tick(_reason: string): Promise<void> {
  if (running || paused) return;
  // ★ navigator.onLine === false 时不发起尝试、不增 attempt(m1-04 §4)
  if (!navigator.onLine) return;
  if (!auth.get()) return;

  running = true;
  try {
    const run = async () => {
      const now = Date.now();
      const all = await allCaptures();
      const ready = all.filter(
        (r) =>
          (r.state === 'pending' || r.state === 'pending_discard') &&
          r.person_id !== null &&
          r.next_attempt_at <= now &&
          !(r.attempt >= FOREGROUND_ONLY_AFTER && document.visibilityState !== 'visible'),
      );
      for (const rec of ready) {
        if (paused || !navigator.onLine) break;
        const fresh = await getCapture(rec.client_document_id);
        if (!fresh) continue;
        if (fresh.state === 'pending_discard') await processDiscard(fresh);
        else await processOne(fresh);
        events.onChange?.();
      }
    };
    if (navigator.locks?.request) {
      await navigator.locks.request('amr-upload-queue', { ifAvailable: true }, async (lock) => {
        if (lock) await run();
      });
    } else {
      await run();   // 不支持 Web Locks(含非安全上下文):各标签页各自推进,服务端幂等兜底
    }
  } finally {
    running = false;
    events.onChange?.();
  }
}

/** online 与前台化必须把 pending 项的 next_attempt_at 置 0
 *  —— 网络类退避不跨越网络状态变化(审核 #002 A-17) */
async function resetBackoff(): Promise<void> {
  const all = await allCaptures();
  for (const r of all) {
    if (r.state === 'pending' && r.next_attempt_at > Date.now()) {
      await putCapture({ ...r, next_attempt_at: 0 });
    }
  }
}

export function startQueueDriver(): () => void {
  const onOnline = () => {
    void resetBackoff().then(() => tick('online'));
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') void resetBackoff().then(() => tick('foreground'));
  };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void tick('interval');
  }, 30_000);
  void tick('start');
  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    if (timer !== null) window.clearInterval(timer);
  };
}
