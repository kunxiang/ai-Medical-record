import {
  canonicalJsonString, type ContextAnswerInputT, type ContextMediaMimeT, type ContextQuestionT,
} from '@amr/contracts';
import { uuidv7 } from 'uuidv7';
import { api, ApiFailure, auth } from '../api/client.js';
import { sha256Hex } from './capture.js';
import {
  allContextSessions, contextAnswersForSession, contextMediaForSession,
  contextSessionForDocument, contextTemplatesForPerson, deleteContextMedia,
  getContextSession, getContextTemplateForPerson, kvSet, putContextAnswer,
  putContextMedia, putContextSession, putContextTemplate,
  type ContextLocalAnswer, type ContextLocalMedia, type ContextLocalSession,
  type ContextTemplateCacheRecord, type PersonCacheRecord,
} from './db.js';

type Profile = { id: string; birth_date: string; sex_at_birth: 'male' | 'female' | 'unknown' };
type PersonRef = Pick<PersonCacheRecord, 'id' | 'display_name'>;

function ageOn(birthDate: string, localDate: string): number {
  const [birthYear, birthMonth, birthDay] = birthDate.split('-').map(Number);
  const [year, month, day] = localDate.split('-').map(Number);
  let age = year! - birthYear!;
  if (month! < birthMonth! || (month === birthMonth && day! < birthDay!)) age -= 1;
  return Math.max(0, age);
}

export function contextLocalDate(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields['year']}-${fields['month']}-${fields['day']}`;
}

function resolveQuestions(
  template: Awaited<ReturnType<typeof api.contextTemplate>>,
  stage: 'onsite' | 'same_day' | 'anytime',
  profile: Profile,
  timeZone: string,
): ContextQuestionT[] {
  const age = ageOn(profile.birth_date, contextLocalDate(timeZone));
  const appended = template.conditional.filter((condition) => {
    if (condition.append_to !== stage) return false;
    if (condition.when.sex_at_birth !== undefined
        && condition.when.sex_at_birth !== profile.sex_at_birth) return false;
    const range = condition.when.age_between;
    return range === undefined || (age >= range[0] && age <= range[1]);
  }).flatMap((condition) => condition.questions);
  return [...(template.stages[stage]?.questions ?? []), ...appended];
}

async function definitionHash(template: Awaited<ReturnType<typeof api.contextTemplate>>): Promise<string> {
  const { template_hash: _hash, ...definition } = template;
  const bytes = new TextEncoder().encode(canonicalJsonString(definition));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 登录在线时刷新全部历史版本，并按 person 条件冻结每个 stage 的问题 snapshot。 */
export async function refreshContextTemplateCache(
  profiles: Profile[],
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Promise<number> {
  const manifest = await api.contextTemplates();
  let cached = 0;
  for (const entry of manifest.templates) {
    for (const version of entry.versions) {
      const template = await api.contextTemplate(entry.template_id, version.version);
      if (template.template_hash !== version.hash || await definitionHash(template) !== template.template_hash) {
        throw new Error(`情境模板 ${entry.template_id}@${version.version} hash 校验失败`);
      }
      for (const profile of profiles) {
        for (const stage of ['onsite', 'same_day', 'anytime'] as const) {
          if (!template.stages[stage]) continue;
          const record: ContextTemplateCacheRecord = {
            person_id: profile.id,
            template_id: template.template_id,
            version: template.version,
            stage,
            template_hash: template.template_hash,
            template,
            questions: resolveQuestions(template, stage, profile, timeZone),
            cached_at: new Date().toISOString(),
          };
          await putContextTemplate(record);
          cached += 1;
        }
      }
    }
  }
  await kvSet('context_template_manifest', manifest);
  await kvSet('context_templates_fetched_at', new Date().toISOString());
  return cached;
}

export async function availableContextTemplates(
  personId: string,
  stage: 'onsite' | 'same_day' | 'anytime',
): Promise<ContextTemplateCacheRecord[]> {
  const records = (await contextTemplatesForPerson(personId)).filter((item) => item.stage === stage);
  const latest = new Map<string, ContextTemplateCacheRecord>();
  for (const record of records) {
    const current = latest.get(record.template_id);
    if (!current || record.version > current.version) latest.set(record.template_id, record);
  }
  return [...latest.values()].sort((left, right) => left.template_id.localeCompare(right.template_id));
}

function baseSession(input: {
  person: PersonRef; scopeType: 'document' | 'standalone'; scopeKey: string;
  clientDocumentId: string | null; stage: 'onsite' | 'same_day' | 'anytime';
}): ContextLocalSession {
  const now = new Date().toISOString();
  return {
    id: uuidv7(), person_id: input.person.id, person_display_name: input.person.display_name,
    scope_type: input.scopeType, scope_key: input.scopeKey,
    client_document_id: input.clientDocumentId, encounter_id: null,
    template_id: null, template_version: null, template_hash: null,
    question_snapshot: [], stage: input.stage, sync_state: 'needs_template',
    server_revision: null, server_status: null, document_bound: false,
    complete_requested: false,
    create_operation_id: uuidv7(), bind_operation_id: uuidv7(),
    answer_operation_id: uuidv7(), complete_operation_id: uuidv7(),
    created_at: now, updated_at: now, last_error: null,
  };
}

export async function ensureDocumentContextPlaceholder(
  person: PersonRef,
  clientDocumentId: string,
  stage: 'onsite' | 'same_day' = 'onsite',
): Promise<ContextLocalSession> {
  const existing = await contextSessionForDocument(clientDocumentId, stage);
  if (existing) return existing;
  const session = baseSession({
    person, scopeType: 'document', scopeKey: clientDocumentId,
    clientDocumentId, stage,
  });
  await putContextSession(session);
  return session;
}

/** 现场记录完成后，为存在 same_day 模板的文档建立当天补录占位。 */
export async function ensureSameDayContextPlaceholder(
  onsite: ContextLocalSession,
): Promise<ContextLocalSession | null> {
  if (onsite.scope_type !== 'document' || !onsite.client_document_id
      || !onsite.template_id || onsite.template_version === null) return null;
  const cached = await getContextTemplateForPerson(
    onsite.person_id, onsite.template_id, onsite.template_version, 'same_day',
  );
  if (!cached) return null;
  const existing = await contextSessionForDocument(onsite.client_document_id, 'same_day');
  if (existing) return existing;
  const session = baseSession({
    person: { id: onsite.person_id, display_name: onsite.person_display_name },
    scopeType: 'document', scopeKey: onsite.client_document_id,
    clientDocumentId: onsite.client_document_id, stage: 'same_day',
  });
  const configured: ContextLocalSession = {
    ...session,
    template_id: cached.template_id,
    template_version: cached.version,
    template_hash: cached.template_hash,
    question_snapshot: cached.questions,
    sync_state: 'pending',
  };
  await putContextSession(configured);
  return configured;
}

export async function createStandaloneContextPlaceholder(person: PersonRef): Promise<ContextLocalSession> {
  const session = baseSession({
    person, scopeType: 'standalone', scopeKey: '', clientDocumentId: null, stage: 'anytime',
  });
  session.scope_key = session.id;
  await putContextSession(session);
  return session;
}

export async function configureContextSession(
  sessionId: string,
  templateId: string,
  version: number,
): Promise<ContextLocalSession> {
  const session = await getContextSession(sessionId);
  if (!session) throw new Error('本地情境记录不存在');
  const cached = await getContextTemplateForPerson(session.person_id, templateId, version, session.stage);
  if (!cached) throw new Error('模板尚未缓存；请联网后稍后补录');
  const updated: ContextLocalSession = {
    ...session,
    template_id: cached.template_id,
    template_version: cached.version,
    template_hash: cached.template_hash,
    question_snapshot: cached.questions,
    sync_state: 'draft',
    updated_at: new Date().toISOString(),
    last_error: null,
  };
  await putContextSession(updated);
  return updated;
}

export async function saveContextAnswer(
  sessionId: string,
  answer: ContextAnswerInputT,
): Promise<void> {
  const session = await getContextSession(sessionId);
  if (!session) throw new Error('本地情境记录不存在');
  const record: ContextLocalAnswer = {
    session_id: sessionId, question_key: answer.question_key, answer,
    state: 'pending', updated_at: new Date().toISOString(),
  };
  await putContextAnswer(record);
  await putContextSession({
    ...session, sync_state: 'pending', answer_operation_id: uuidv7(),
    updated_at: new Date().toISOString(), last_error: null,
  });
}

export async function attachContextMedia(
  sessionId: string,
  question: ContextQuestionT,
  blob: Blob,
): Promise<ContextLocalMedia> {
  if (question.answer_type !== 'audio' && question.answer_type !== 'photo') {
    throw new Error('该问题不接受媒体附件');
  }
  const mime = blob.type.toLowerCase().split(';')[0]!.trim();
  const allowed: ContextMediaMimeT[] = question.answer_type === 'audio'
    ? ['audio/mp4', 'audio/webm', 'audio/mpeg', 'audio/wav']
    : ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(mime as ContextMediaMimeT)) throw new Error('媒体格式不受支持，可改用文字或重新选择');
  const safeMime = mime as ContextMediaMimeT;
  const session = await getContextSession(sessionId);
  if (!session) throw new Error('本地情境记录不存在');
  for (const prior of await contextMediaForSession(sessionId)) {
    if (prior.question_key === question.key && prior.state !== 'finalized') await deleteContextMedia(prior.id);
  }
  const now = new Date().toISOString();
  const record: ContextLocalMedia = {
    id: uuidv7(), session_id: sessionId, person_id: session.person_id, question_key: question.key,
    kind: question.answer_type, mime: safeMime, blob: new Blob([await blob.arrayBuffer()], { type: safeMime }),
    byte_size: blob.size, sha256: await sha256Hex(blob), state: 'pending', remote_upload_id: null,
    prepare_operation_id: uuidv7(), finalize_operation_id: uuidv7(), multipart: null,
    created_at: now, updated_at: now, last_error: null,
  };
  await putContextMedia(record);
  await putContextSession({ ...session, sync_state: 'pending', updated_at: now });
  return record;
}

export async function requestContextCompletion(sessionId: string): Promise<void> {
  const session = await getContextSession(sessionId);
  if (!session) throw new Error('本地情境记录不存在');
  await putContextSession({
    ...session, complete_requested: true, complete_operation_id: uuidv7(),
    sync_state: 'pending', updated_at: new Date().toISOString(),
  });
}

export async function hydrateRemoteContextSession(
  sessionId: string,
  personDisplayName: string,
): Promise<ContextLocalSession> {
  const remote = await api.contextSession(sessionId);
  const existing = await getContextSession(sessionId);
  const now = new Date().toISOString();
  const local: ContextLocalSession = {
    id: remote.session.id,
    person_id: remote.session.person_id,
    person_display_name: existing?.person_display_name ?? personDisplayName,
    scope_type: remote.session.scope_type,
    scope_key: remote.session.scope_key,
    client_document_id: remote.session.client_document_id,
    encounter_id: remote.session.encounter_id,
    template_id: remote.session.template_id,
    template_version: remote.session.template_version,
    template_hash: remote.session.template_hash,
    question_snapshot: remote.session.question_snapshot,
    stage: remote.session.stage,
    sync_state: remote.session.status === 'completed' ? 'completed' : 'synced',
    server_revision: remote.session.revision,
    server_status: remote.session.status,
    document_bound: remote.session.document_id !== null,
    complete_requested: remote.session.status === 'completed',
    create_operation_id: existing?.create_operation_id ?? uuidv7(),
    bind_operation_id: existing?.bind_operation_id ?? uuidv7(),
    answer_operation_id: existing?.answer_operation_id ?? uuidv7(),
    complete_operation_id: existing?.complete_operation_id ?? uuidv7(),
    created_at: existing?.created_at ?? remote.session.created_at,
    updated_at: now,
    last_error: null,
  };
  await putContextSession(local);
  for (const answer of remote.answers) {
    await putContextAnswer({
      session_id: local.id,
      question_key: answer.question_key,
      answer: answer.skipped
        ? {
            question_key: answer.question_key, answer_type: answer.answer_type,
            value: null, skipped: true, answered_at: answer.answered_at,
          }
        : answer.answer_type === 'audio' || answer.answer_type === 'photo'
          ? {
              question_key: answer.question_key, answer_type: answer.answer_type,
              value: { upload_id: answer.upload_id! }, skipped: false, answered_at: answer.answered_at,
            }
          : {
              question_key: answer.question_key, answer_type: answer.answer_type,
              value: answer.value as never, skipped: false, answered_at: answer.answered_at,
            },
      state: 'synced', updated_at: now,
    });
  }
  return local;
}

export async function retryContextConflict(sessionId: string): Promise<ContextLocalSession> {
  const session = await getContextSession(sessionId);
  if (!session) throw new Error('本地情境记录不存在');
  const remote = await api.contextSession(sessionId);
  const updated: ContextLocalSession = {
    ...session,
    server_revision: remote.session.revision,
    server_status: remote.session.status,
    document_bound: remote.session.document_id !== null,
    answer_operation_id: uuidv7(), bind_operation_id: uuidv7(), complete_operation_id: uuidv7(),
    sync_state: 'pending', last_error: null, updated_at: new Date().toISOString(),
  };
  await putContextSession(updated);
  for (const answer of await contextAnswersForSession(sessionId)) {
    if (answer.state === 'conflict') await putContextAnswer({ ...answer, state: 'pending' });
  }
  return syncContextSession(sessionId);
}

async function syncMedia(record: ContextLocalMedia): Promise<ContextLocalMedia> {
  let working: ContextLocalMedia = {
    ...record, state: 'uploading', updated_at: new Date().toISOString(),
  };
  await putContextMedia(working);
  if (!working.remote_upload_id) {
    const remote = await api.prepareContextUpload({
      client_operation_id: working.prepare_operation_id,
      person_id: working.person_id, session_id: working.session_id,
      question_key: working.question_key, kind: working.kind,
      mime: working.mime, byte_size: working.byte_size, sha256: working.sha256,
    });
    working = { ...working, remote_upload_id: remote.id, updated_at: new Date().toISOString() };
    await putContextMedia(working);
  }
  const remoteUploadId = working.remote_upload_id;
  if (!remoteUploadId) throw new Error('媒体 prepare 未返回 upload_id');
  let signed: Awaited<ReturnType<typeof api.presignContextUpload>>;
  try {
    signed = await api.presignContextUpload(remoteUploadId);
  } catch (error) {
    // finalize 已成功、但浏览器在写回本地 state 前崩溃：读取远端终态后继续，不能重传。
    if (!(error instanceof ApiFailure && error.code === 'validation_failed')) throw error;
    const remote = await api.contextUpload(remoteUploadId);
    if (remote.upload.state !== 'finalized') throw error;
    working = { ...working, state: 'finalized', last_error: null, updated_at: new Date().toISOString() };
    await putContextMedia(working);
    await putContextAnswer({
      session_id: working.session_id, question_key: working.question_key,
      answer: {
        question_key: working.question_key, answer_type: working.kind,
        value: { upload_id: remoteUploadId }, skipped: false, answered_at: new Date().toISOString(),
      },
      state: 'pending', updated_at: new Date().toISOString(),
    });
    return working;
  }
  if (signed.mode === 'single') {
    const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: working.blob });
    if (!response.ok) throw new Error(`媒体上传失败：${response.status}`);
  } else {
    const complete = new Map((working.multipart?.parts ?? []).map((part) => [part.part_number, part.etag]));
    for (const part of signed.parts) {
      if (complete.has(part.part_number)) continue;
      const start = (part.part_number - 1) * signed.part_size;
      const response = await fetch(part.url, {
        method: 'PUT', body: working.blob.slice(start, Math.min(start + signed.part_size, working.byte_size)),
      });
      if (!response.ok) throw new Error(`媒体分片 ${part.part_number} 上传失败：${response.status}`);
      const etag = response.headers.get('etag');
      if (!etag) throw new Error('对象存储没有暴露 ETag');
      complete.set(part.part_number, etag);
      working = {
        ...working,
        multipart: {
          part_size: signed.part_size, part_count: signed.part_count,
          parts: [...complete.entries()].map(([part_number, value]) => ({ part_number, etag: value }))
            .sort((left, right) => left.part_number - right.part_number),
        },
        updated_at: new Date().toISOString(),
      };
      await putContextMedia(working);
    }
  }
  working = { ...working, state: 'pending_finalize', updated_at: new Date().toISOString() };
  await putContextMedia(working);
  await api.finalizeContextUpload(remoteUploadId, {
    client_operation_id: working.finalize_operation_id,
    parts: working.multipart?.parts ?? [],
  });
  working = { ...working, state: 'finalized', last_error: null, updated_at: new Date().toISOString() };
  await putContextMedia(working);
  await putContextAnswer({
    session_id: working.session_id, question_key: working.question_key,
    answer: {
      question_key: working.question_key, answer_type: working.kind,
      value: { upload_id: remoteUploadId }, skipped: false, answered_at: new Date().toISOString(),
    },
    state: 'pending', updated_at: new Date().toISOString(),
  });
  return working;
}

function localFailure(error: unknown): { code: string; message: string; at: string } {
  return {
    code: error instanceof ApiFailure ? error.code : 'network',
    message: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString(),
  };
}

export async function syncContextSession(sessionId: string): Promise<ContextLocalSession> {
  let session = await getContextSession(sessionId);
  if (!session) throw new Error('本地情境记录不存在');
  if (session.sync_state === 'needs_template' || !session.template_id
      || session.template_version === null || !session.template_hash) return session;
  const templateId = session.template_id;
  const templateVersion = session.template_version;
  const templateHash = session.template_hash;
  if (!navigator.onLine || !auth.get()) return session;
  session = { ...session, sync_state: 'syncing', updated_at: new Date().toISOString() };
  await putContextSession(session);
  try {
    if (session.server_revision === null) {
      const created = await api.createContextSession({
        client_operation_id: session.create_operation_id,
        id: session.id, person_id: session.person_id,
        scope_type: session.scope_type, scope_key: session.scope_key,
        client_document_id: session.client_document_id, document_id: null,
        encounter_id: session.encounter_id,
        template_id: templateId, template_version: templateVersion,
        template_hash: templateHash, question_snapshot: session.question_snapshot,
        stage: session.stage,
      });
      session = {
        ...session, server_revision: created.session.revision,
        server_status: created.session.status, document_bound: created.session.document_id !== null,
      };
      await putContextSession(session);
    }

    if (session.scope_type === 'document' && !session.document_bound) {
      try {
        const bound = await api.bindContextDocument(session.id, {
          client_operation_id: session.bind_operation_id, if_revision: session.server_revision!,
        });
        session = {
          ...session, server_revision: bound.session.revision,
          server_status: bound.session.status, document_bound: bound.session.document_id !== null,
        };
        await putContextSession(session);
      } catch (error) {
        if (!(error instanceof ApiFailure && error.status === 404)) throw error;
      }
    }

    for (const media of await contextMediaForSession(session.id)) {
      if (media.state === 'finalized') continue;
      try {
        await syncMedia(media);
      } catch (error) {
        await putContextMedia({
          ...media, state: 'failed', last_error: localFailure(error).message,
          updated_at: new Date().toISOString(),
        });
        throw error;
      }
    }

    const pendingAnswers = (await contextAnswersForSession(session.id))
      .filter((answer) => answer.state !== 'synced');
    if (pendingAnswers.length > 0) {
      const response = await api.upsertContextAnswers(session.id, {
        client_operation_id: session.answer_operation_id,
        if_revision: session.server_revision!,
        answers: pendingAnswers.map((answer) => answer.answer),
      });
      for (const answer of pendingAnswers) await putContextAnswer({ ...answer, state: 'synced' });
      session = {
        ...session, server_revision: response.session.revision,
        server_status: response.session.status,
      };
      await putContextSession(session);
    }

    if (session.complete_requested && session.server_status !== 'completed') {
      const response = await api.completeContextSession(session.id, {
        client_operation_id: session.complete_operation_id, if_revision: session.server_revision!,
      });
      session = {
        ...session, server_revision: response.session.revision,
        server_status: response.session.status,
      };
    }
    session = {
      ...session,
      sync_state: session.server_status === 'completed' && (session.scope_type === 'standalone' || session.document_bound)
        ? 'completed'
        : session.scope_type === 'document' && !session.document_bound ? 'pending' : 'synced',
      last_error: null, updated_at: new Date().toISOString(),
    };
    await putContextSession(session);
    return session;
  } catch (error) {
    const conflict = error instanceof ApiFailure && error.code === 'revision_conflict';
    session = {
      ...session, sync_state: conflict ? 'conflict' : 'pending',
      last_error: localFailure(error), updated_at: new Date().toISOString(),
    };
    await putContextSession(session);
    if (conflict) {
      for (const answer of await contextAnswersForSession(session.id)) {
        if (answer.state !== 'synced') await putContextAnswer({ ...answer, state: 'conflict' });
      }
    }
    return session;
  }
}

export async function syncAllContext(): Promise<number> {
  if (!navigator.onLine || !auth.get()) return 0;
  let changed = 0;
  for (const session of await allContextSessions()) {
    if (session.sync_state === 'needs_template') continue;
    const before = `${session.sync_state}:${session.server_revision}:${session.document_bound}`;
    const after = await syncContextSession(session.id);
    if (`${after.sync_state}:${after.server_revision}:${after.document_bound}` !== before) changed += 1;
  }
  return changed;
}
