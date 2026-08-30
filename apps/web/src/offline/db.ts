import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  ContextAnswerInputT, ContextMediaMimeT, ContextQuestionT, ContextStageT, ContextTemplateSnapshotT,
} from '@amr/contracts';

// spec m1-04 §1:四个 store。原件 blob 与元数据分表 —— 元数据频繁读写(状态机、
// 重试计数),blob 只在上传时读一次;分开可避免每次状态更新都搬运几 MB。

export type CaptureState =
  | 'draft'            // 累积面板中,尚未定稿
  | 'pending_person'   // 已定稿但未选人(离线且人员缓存缺失)
  | 'pending'
  | 'uploading'
  | 'registering'
  | 'pending_discard'  // 用户已放弃,等待联网上报
  | 'failed_terminal';

export interface CaptureRecord {
  client_document_id: string;      // ★ 拍摄瞬间生成的 uuid v7,幂等锚点,终生不变
  person_id: string | null;
  person_slug: string | null;
  person_display_name: string | null;
  source: 'camera' | 'album' | 'pdf';
  captured_at: string;             // EXIF DateTimeOriginal 优先,否则入队时刻
  captured_at_from_exif: boolean;
  page_count: number;
  state: CaptureState;
  attempt: number;
  next_attempt_at: number;
  last_error: { stage: 'presign' | 'put' | 'register'; code: string; message: string; at: string } | null;
  batch: {
    batch_id: string;
    uploads: Array<{
      page_no: number;
      upload_id: string;             // upload_file.id，登记时继续使用
      mode: 'single' | 'multipart';
      url: string | null;
      headers: Record<string, string>;
      expires_at: string | null;
      single_completed?: boolean;
      multipart?: {
        upload_id: string;           // S3 opaque UploadId
        key: string;
        part_size: number;
        part_count: number;
        parts: Array<{ part_number: number; etag: string }>;
        completed: boolean;
      };
    }>;
  } | null;
  discard_event_id: string | null;
  created_at: string;
  context: null;                   // M3 预留
}

export interface BlobRecord {
  client_document_id: string;
  page_no: number;
  blob: Blob;                      // ★ 必须是物化的 Blob,不是 File(审核 #002 A-9)
  byte_size: number;
  sha256: string;
  mime_type: string;
  width: number;
  height: number;
  capture_order: number;
  filename: string;
  exif: { captured_at: string | null; orientation: number | null } | null;
}

export interface PersonCacheRecord {
  id: string;
  slug: string;
  display_name: string;
  relation_to_owner: string;
  // ★ 只缓存这四项:选择器不需要过敏史/生日,而它们是医疗 PII(m1-04 §5)
}

export interface ContextTemplateCacheRecord {
  person_id: string;
  template_id: string;
  version: number;
  stage: ContextStageT;
  template_hash: string;
  template: ContextTemplateSnapshotT;
  questions: ContextQuestionT[];
  cached_at: string;
}

export type ContextLocalSyncState =
  | 'needs_template'
  | 'draft'
  | 'pending'
  | 'syncing'
  | 'conflict'
  | 'synced'
  | 'completed';

export interface ContextLocalSession {
  id: string;
  person_id: string;
  person_display_name: string;
  scope_type: 'document' | 'standalone';
  scope_key: string;
  client_document_id: string | null;
  encounter_id: string | null;
  template_id: string | null;
  template_version: number | null;
  template_hash: string | null;
  question_snapshot: ContextQuestionT[];
  stage: ContextStageT;
  sync_state: ContextLocalSyncState;
  server_revision: number | null;
  server_status: 'active' | 'completed' | null;
  document_bound: boolean;
  complete_requested: boolean;
  create_operation_id: string;
  bind_operation_id: string;
  answer_operation_id: string;
  complete_operation_id: string;
  created_at: string;
  updated_at: string;
  last_error: { code: string; message: string; at: string } | null;
}

export interface ContextLocalAnswer {
  session_id: string;
  question_key: string;
  answer: ContextAnswerInputT;
  state: 'draft' | 'pending' | 'synced' | 'conflict';
  updated_at: string;
}

export interface ContextLocalMedia {
  id: string;
  session_id: string;
  person_id: string;
  question_key: string;
  kind: 'audio' | 'photo';
  mime: ContextMediaMimeT;
  blob: Blob;
  byte_size: number;
  sha256: string;
  state: 'draft' | 'pending' | 'uploading' | 'pending_finalize' | 'finalized' | 'failed';
  remote_upload_id: string | null;
  prepare_operation_id: string;
  finalize_operation_id: string;
  multipart: {
    part_size: number;
    part_count: number;
    parts: Array<{ part_number: number; etag: string }>;
  } | null;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export interface ObservationDraftRow {
  client_row_id: string;
  local_name: string;
  concept_code: string | null;
  concept_catalog_version: string | null;
  value_raw: string;
  unit_raw: string;
  ref_low: string;
  ref_high: string;
  ref_text: string;
  abnormal_flag_raw: string;
  source_page_no: number | null;
}

export interface ObservationDraftRecord {
  draft_key: string;
  person_id: string;
  document_id: string | null;
  document_title: string | null;
  client_operation_id: string;
  defaults: {
    encounter_id: string | null;
    observed_on: string;
    time_precision: 'date' | 'minute' | 'unknown';
    observed_at: string | null;
    date_source: 'manual' | 'document_sampled' | 'document_reported';
    specimen: string;
    method: string;
    device: string;
  };
  rows: ObservationDraftRow[];
  created_at: string;
  updated_at: string;
}

interface AmrDB extends DBSchema {
  captures: { key: string; value: CaptureRecord; indexes: { idx_state: string; idx_created: string } };
  blobs: { key: [string, number]; value: BlobRecord };
  people_cache: { key: string; value: PersonCacheRecord };
  kv: { key: string; value: { k: string; v: unknown } };
  context_templates: {
    key: [string, string, number, string]; value: ContextTemplateCacheRecord;
    indexes: { idx_person: string };
  };
  context_sessions: {
    key: string; value: ContextLocalSession;
    indexes: { idx_person: string; idx_client_document: string; idx_sync_state: string };
  };
  context_answers: {
    key: [string, string]; value: ContextLocalAnswer;
    indexes: { idx_session: string };
  };
  context_media: {
    key: string; value: ContextLocalMedia;
    indexes: { idx_session: string; idx_state: string };
  };
  observation_drafts: {
    key: string; value: ObservationDraftRecord;
    indexes: { idx_person: string; idx_document: string };
  };
}

let dbPromise: Promise<IDBPDatabase<AmrDB>> | null = null;
let activeDb: IDBPDatabase<AmrDB> | null = null;

function invalidateDb(connection: IDBPDatabase<AmrDB>): void {
  if (activeDb !== connection) return;
  activeDb = null;
  dbPromise = null;
}

function openCaptureDb(): Promise<IDBPDatabase<AmrDB>> {
  let opened: IDBPDatabase<AmrDB> | null = null;
  const opening = openDB<AmrDB>('amr-capture', 3, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
      const captures = d.createObjectStore('captures', { keyPath: 'client_document_id' });
      captures.createIndex('idx_state', 'state');
      captures.createIndex('idx_created', 'created_at');
      d.createObjectStore('blobs', { keyPath: ['client_document_id', 'page_no'] });
      d.createObjectStore('people_cache', { keyPath: 'id' });
      d.createObjectStore('kv', { keyPath: 'k' });
      }
      if (oldVersion < 2) {
        const templates = d.createObjectStore('context_templates', {
          keyPath: ['person_id', 'template_id', 'version', 'stage'],
        });
        templates.createIndex('idx_person', 'person_id');
        const sessions = d.createObjectStore('context_sessions', { keyPath: 'id' });
        sessions.createIndex('idx_person', 'person_id');
        sessions.createIndex('idx_client_document', 'client_document_id');
        sessions.createIndex('idx_sync_state', 'sync_state');
        const answers = d.createObjectStore('context_answers', {
          keyPath: ['session_id', 'question_key'],
        });
        answers.createIndex('idx_session', 'session_id');
        const media = d.createObjectStore('context_media', { keyPath: 'id' });
        media.createIndex('idx_session', 'session_id');
        media.createIndex('idx_state', 'state');
      }
      if (oldVersion < 3) {
        const drafts = d.createObjectStore('observation_drafts', { keyPath: 'draft_key' });
        drafts.createIndex('idx_person', 'person_id');
        drafts.createIndex('idx_document', 'document_id');
      }
    },
    blocking() {
      if (!opened) return;
      invalidateDb(opened);
      opened.close();
    },
    terminated() {
      if (opened) invalidateDb(opened);
    },
  });
  dbPromise = opening;
  void opening.then(
    (connection) => {
      opened = connection;
      if (dbPromise === opening) activeDb = connection;
    },
    () => {
      if (dbPromise === opening) dbPromise = null;
    },
  );
  return opening;
}

export function db(): Promise<IDBPDatabase<AmrDB>> {
  return dbPromise ?? openCaptureDb();
}

export async function withDb<T>(operation: (connection: IDBPDatabase<AmrDB>) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const connection = await db();
    try {
      return await operation(connection);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'InvalidStateError' && attempt === 0)) throw error;
      // Chrome 在终止连接与派发 close 事件之间仍可能把旧连接交给调用方。
      // 只对 IDBDatabase.transaction 的关闭态错误重开一次；持续失败必须原样暴露。
      invalidateDb(connection);
      connection.close();
    }
  }
  throw new Error('IndexedDB 连接重开后仍不可用');
}

export async function kvGet<T>(k: string): Promise<T | undefined> {
  const row = await withDb((connection) => connection.get('kv', k));
  return row?.v as T | undefined;
}
export async function kvSet(k: string, v: unknown): Promise<void> {
  await withDb((connection) => connection.put('kv', { k, v }));
}

/** 2xx 后:同一个跨两 store 的事务里删除元数据与 blob(m1-04 §2.5)。
 *  ⚠️ 网络调用必须在事务之外完成 —— IDB 事务在让出事件循环时自动提交。 */
export async function deleteCaptureCompletely(id: string, pageCount: number): Promise<void> {
  await withDb(async (connection) => {
    const tx = connection.transaction(['captures', 'blobs'], 'readwrite');
    await tx.objectStore('captures').delete(id);
    const blobs = tx.objectStore('blobs');
    for (let p = 1; p <= pageCount; p++) await blobs.delete([id, p]);
    await tx.done;
  });
}

export async function putCapture(rec: CaptureRecord): Promise<void> {
  await withDb((connection) => connection.put('captures', rec));
}
export async function getCapture(id: string): Promise<CaptureRecord | undefined> {
  return withDb((connection) => connection.get('captures', id));
}
export async function allCaptures(): Promise<CaptureRecord[]> {
  return withDb((connection) => connection.getAll('captures'));
}

/** 注销账户后的设备清理。只有服务端已经确认注销后才能调用：
 * captures/blobs 可能是尚未上传的唯一副本，普通退出登录绝不能清除。 */
export async function clearAllLocalData(): Promise<void> {
  await withDb(async (connection) => {
    const tx = connection.transaction([
      'captures', 'blobs', 'people_cache', 'kv',
      'context_templates', 'context_sessions', 'context_answers', 'context_media',
      'observation_drafts',
    ], 'readwrite');
    await Promise.all([
      tx.objectStore('captures').clear(),
      tx.objectStore('blobs').clear(),
      tx.objectStore('people_cache').clear(),
      tx.objectStore('kv').clear(),
      tx.objectStore('context_templates').clear(),
      tx.objectStore('context_sessions').clear(),
      tx.objectStore('context_answers').clear(),
      tx.objectStore('context_media').clear(),
      tx.objectStore('observation_drafts').clear(),
    ]);
    await tx.done;
  });
}
export async function getBlob(id: string, pageNo: number): Promise<BlobRecord | undefined> {
  return withDb((connection) => connection.get('blobs', [id, pageNo]));
}
export async function putBlob(rec: BlobRecord): Promise<void> {
  await withDb((connection) => connection.put('blobs', rec));
}
export async function blobsOf(id: string, pageCount: number): Promise<BlobRecord[]> {
  const out: BlobRecord[] = [];
  for (let p = 1; p <= pageCount; p++) {
    const b = await getBlob(id, p);
    if (b) out.push(b);
  }
  return out;
}

/** 崩溃恢复:uploading/registering 回退 pending。multipart 的 UploadId 与已完成 ETag
 * 必须保留；否则刷新会把真正的断点续传退化成整文件重传。 */
export async function recoverAfterRestart(): Promise<number> {
  return withDb(async (connection) => {
    const tx = connection.transaction(['captures', 'context_sessions', 'context_media'], 'readwrite');
    let n = 0;
    for await (const cursor of tx.objectStore('captures')) {
      const rec = cursor.value;
      if (rec.state === 'uploading' || rec.state === 'registering') {
        const resumable = rec.batch?.uploads.some((upload) => upload.multipart) ?? false;
        await cursor.update({
          ...rec, state: 'pending', batch: resumable ? rec.batch : null, next_attempt_at: 0,
        });
        n += 1;
      }
    }
    for await (const cursor of tx.objectStore('context_sessions')) {
      const rec = cursor.value;
      if (rec.sync_state === 'syncing') {
        await cursor.update({ ...rec, sync_state: 'pending', updated_at: new Date().toISOString() });
        n += 1;
      }
    }
    for await (const cursor of tx.objectStore('context_media')) {
      const rec = cursor.value;
      if (rec.state === 'uploading' || rec.state === 'pending_finalize') {
        await cursor.update({ ...rec, state: 'pending', updated_at: new Date().toISOString() });
        n += 1;
      }
    }
    await tx.done;
    return n;
  });
}

export async function allCachedPeople(): Promise<PersonCacheRecord[]> {
  return withDb((connection) => connection.getAll('people_cache'));
}

export async function replaceCachedPeople(people: PersonCacheRecord[]): Promise<void> {
  await withDb(async (connection) => {
    const tx = connection.transaction('people_cache', 'readwrite');
    await tx.store.clear();
    for (const person of people) await tx.store.put(person);
    await tx.done;
  });
}

export async function putCachedPerson(person: PersonCacheRecord): Promise<void> {
  await withDb((connection) => connection.put('people_cache', person));
}

export async function putContextTemplate(record: ContextTemplateCacheRecord): Promise<void> {
  await withDb((connection) => connection.put('context_templates', record));
}

export async function contextTemplatesForPerson(personId: string): Promise<ContextTemplateCacheRecord[]> {
  return withDb((connection) => connection.getAllFromIndex('context_templates', 'idx_person', personId));
}

export async function getContextTemplateForPerson(
  personId: string,
  templateId: string,
  version: number,
  stage: ContextStageT,
): Promise<ContextTemplateCacheRecord | undefined> {
  return withDb((connection) => connection.get(
    'context_templates', [personId, templateId, version, stage],
  ));
}

export async function putContextSession(record: ContextLocalSession): Promise<void> {
  await withDb((connection) => connection.put('context_sessions', record));
}

export async function getContextSession(id: string): Promise<ContextLocalSession | undefined> {
  return withDb((connection) => connection.get('context_sessions', id));
}

export async function contextSessionsForPerson(personId: string): Promise<ContextLocalSession[]> {
  return withDb((connection) => connection.getAllFromIndex('context_sessions', 'idx_person', personId));
}

export async function allContextSessions(): Promise<ContextLocalSession[]> {
  return withDb((connection) => connection.getAll('context_sessions'));
}

export async function contextSessionForDocument(
  clientDocumentId: string,
  stage?: ContextStageT,
): Promise<ContextLocalSession | undefined> {
  const sessions = await withDb((connection) => connection.getAllFromIndex(
    'context_sessions', 'idx_client_document', clientDocumentId,
  ));
  return sessions.find((session) => stage === undefined || session.stage === stage);
}

export async function putContextAnswer(record: ContextLocalAnswer): Promise<void> {
  await withDb((connection) => connection.put('context_answers', record));
}

export async function contextAnswersForSession(sessionId: string): Promise<ContextLocalAnswer[]> {
  return withDb((connection) => connection.getAllFromIndex('context_answers', 'idx_session', sessionId));
}

export async function deleteContextAnswer(sessionId: string, questionKey: string): Promise<void> {
  await withDb((connection) => connection.delete('context_answers', [sessionId, questionKey]));
}

export async function putContextMedia(record: ContextLocalMedia): Promise<void> {
  await withDb((connection) => connection.put('context_media', record));
}

export async function getContextMedia(id: string): Promise<ContextLocalMedia | undefined> {
  return withDb((connection) => connection.get('context_media', id));
}

export async function contextMediaForSession(sessionId: string): Promise<ContextLocalMedia[]> {
  return withDb((connection) => connection.getAllFromIndex('context_media', 'idx_session', sessionId));
}

export async function deleteContextMedia(id: string): Promise<void> {
  await withDb((connection) => connection.delete('context_media', id));
}

export async function putObservationDraft(record: ObservationDraftRecord): Promise<void> {
  await withDb((connection) => connection.put('observation_drafts', record));
}

export async function getObservationDraft(key: string): Promise<ObservationDraftRecord | undefined> {
  return withDb((connection) => connection.get('observation_drafts', key));
}

export async function observationDraftsForPerson(personId: string): Promise<ObservationDraftRecord[]> {
  return withDb((connection) => connection.getAllFromIndex('observation_drafts', 'idx_person', personId));
}

export async function deleteObservationDraft(key: string): Promise<void> {
  await withDb((connection) => connection.delete('observation_drafts', key));
}
