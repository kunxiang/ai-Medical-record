import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  ContextAnswer, ContextPendingResponse, ContextSession, ContextSessionDetailResponse,
  canonicalJsonString,
  type ContextAnswerInputT, type ContextAnswerT, type ContextQuestionT,
  type ContextSessionCreateT, type ContextSessionT,
} from '@amr/contracts';
import {
  getContextTemplate, resolveContextQuestions, type ContextTemplatePerson,
} from '@amr/medical';
import { captureDateInZone, serverTimestamp } from '@amr/storage';
import { db, type Tx } from '../db/client.js';
import {
  account, contextAnswer, contextSession, contextUpload, document, documentManualMetadata,
  encounter, person, searchEntry,
} from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { appendJournal } from '../journal.js';
import { recordOperation, replayOperation } from './operation-ledger.js';
import {
  deriveContextEventTime, validateAnswerAgainstQuestion,
} from './context-validation.js';

type ContextSessionRow = typeof contextSession.$inferSelect;
type ContextAnswerRow = typeof contextAnswer.$inferSelect;
type Executor = Tx | typeof db;

function ageOn(birthDate: string, localDate: string): number {
  const [birthYear, birthMonth, birthDay] = birthDate.split('-').map(Number);
  const [year, month, day] = localDate.split('-').map(Number);
  let age = year! - birthYear!;
  if (month! < birthMonth! || (month === birthMonth && day! < birthDay!)) age -= 1;
  return Math.max(0, age);
}

function encodeCursor(createdAt: Date, id: string, personId: string, localDate: string): string {
  return Buffer.from(JSON.stringify({ created_at: createdAt.toISOString(), id, person_id: personId, local_date: localDate }))
    .toString('base64url');
}

function decodeCursor(cursor: string, personId: string, localDate: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.person_id !== personId || parsed.local_date !== localDate
        || typeof parsed.created_at !== 'string' || typeof parsed.id !== 'string') throw new Error();
    const createdAt = new Date(parsed.created_at);
    if (Number.isNaN(createdAt.getTime())) throw new Error();
    return { createdAt, id: parsed.id };
  } catch {
    throw new ApiError('validation_failed', '游标与当前查询不匹配');
  }
}

export function contextSessionOut(row: ContextSessionRow): ContextSessionT {
  return ContextSession.parse({
    id: row.id, person_id: row.personId, scope_type: row.scopeType, scope_key: row.scopeKey,
    client_document_id: row.clientDocumentId, document_id: row.documentId,
    encounter_id: row.encounterId, template_id: row.templateId,
    template_version: row.templateVersion, template_hash: row.templateHash,
    question_snapshot: row.questionSnapshot, stage: row.stage, status: row.status,
    revision: row.revision, created_by: row.createdBy, created_at: row.createdAt.toISOString(),
    updated_by: row.updatedBy, updated_at: row.updatedAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
  });
}

export function contextAnswerOut(row: ContextAnswerRow): ContextAnswerT {
  const media = row.uploadId !== null && (row.answerType === 'audio' || row.answerType === 'photo');
  return ContextAnswer.parse({
    id: row.id, session_id: row.sessionId, question_key: row.questionKey,
    question_text: row.questionText, question_snapshot: row.questionSnapshot,
    answer_type: row.answerType, value: row.skipped ? null : media ? { upload_id: row.uploadId } : row.value,
    upload_id: row.uploadId, skipped: row.skipped,
    answered_at: row.answeredAt?.toISOString() ?? null,
    event_on: row.eventOn, event_at: row.eventAt?.toISOString() ?? null,
    time_precision: row.timePrecision, event_time_source: row.eventTimeSource,
    revision: row.revision, updated_by: row.updatedBy, updated_at: row.updatedAt.toISOString(),
  });
}

async function sessionDetail(sessionId: string, executor: Executor = db) {
  const session = (await executor.select().from(contextSession)
    .where(eq(contextSession.id, sessionId)).limit(1))[0];
  if (!session) throw notFound();
  const answers = await executor.select().from(contextAnswer)
    .where(eq(contextAnswer.sessionId, sessionId));
  const order = new Map((session.questionSnapshot as ContextQuestionT[])
    .map((question, index) => [question.key, index]));
  answers.sort((left, right) => (order.get(left.questionKey) ?? 10_000) - (order.get(right.questionKey) ?? 10_000));
  return ContextSessionDetailResponse.parse({
    session: contextSessionOut(session), answers: answers.map(contextAnswerOut),
  });
}

export async function getContextSessionDetail(sessionId: string) {
  return sessionDetail(sessionId);
}

async function accountTimezone(executor: Executor, accountId: string): Promise<string> {
  const row = (await executor.select({ timezone: account.timezone }).from(account)
    .where(eq(account.id, accountId)).limit(1))[0];
  if (!row) throw notFound();
  return row.timezone;
}

async function lockSession(tx: Tx, sessionId: string): Promise<ContextSessionRow> {
  const row = (await tx.select().from(contextSession).where(eq(contextSession.id, sessionId))
    .limit(1).for('update'))[0];
  if (!row) throw notFound();
  return row;
}

function assertRevision(row: ContextSessionRow, ifRevision: number, draft: unknown): void {
  if (row.revision !== ifRevision) {
    throw new ApiError('revision_conflict', '情境记录已被其他操作更新', {
      base_revision: ifRevision, current: contextSessionOut(row), draft,
    });
  }
}

function ensureSnapshotMatches(input: ContextSessionCreateT, profile: ContextTemplatePerson): void {
  const template = getContextTemplate(input.template_id, input.template_version);
  if (!template || template.template_hash !== input.template_hash) {
    throw new ApiError('validation_failed', '情境模板版本或 hash 不匹配');
  }
  if (!template.stages[input.stage]) {
    throw new ApiError('validation_failed', '该模板不支持所选情境阶段');
  }
  const expected = resolveContextQuestions(template, input.stage, profile);
  if (canonicalJsonString(expected) !== canonicalJsonString(input.question_snapshot)) {
    throw new ApiError('validation_failed', '问题 snapshot 与模板及人员条件不匹配');
  }
}

export async function createContextSession(input: {
  accountId: string; body: ContextSessionCreateT;
}) {
  return db.transaction(async (tx) => {
    const owner = (await tx.select({
      slug: person.slug, birthDate: person.birthDate, sexAtBirth: person.sexAtBirth,
    }).from(person).where(eq(person.id, input.body.person_id)).limit(1).for('update'))[0];
    if (!owner) throw notFound();
    const replay = await replayOperation<ReturnType<typeof ContextSessionDetailResponse.parse>>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request: input.body,
    });
    if (replay.result) return ContextSessionDetailResponse.parse(replay.result);
    if (input.body.document_id !== null) {
      throw new ApiError('validation_failed', '创建 session 时 document_id 必须为空，请使用 bind-document');
    }
    const existing = (await tx.select({ id: contextSession.id }).from(contextSession)
      .where(or(
        eq(contextSession.id, input.body.id),
        and(
          eq(contextSession.personId, input.body.person_id),
          eq(contextSession.scopeType, input.body.scope_type),
          eq(contextSession.scopeKey, input.body.scope_key),
          eq(contextSession.templateId, input.body.template_id),
          eq(contextSession.templateVersion, input.body.template_version),
          eq(contextSession.stage, input.body.stage),
        ),
      )).limit(1))[0];
    if (existing) throw new ApiError('operation_conflict', '该情境 session 已由另一操作创建');
    if (input.body.encounter_id) {
      const linked = (await tx.select({ personId: encounter.personId }).from(encounter)
        .where(eq(encounter.id, input.body.encounter_id)).limit(1))[0];
      if (!linked || linked.personId !== input.body.person_id) throw notFound();
    }
    const at = serverTimestamp();
    const timezone = await accountTimezone(tx, input.accountId);
    ensureSnapshotMatches(input.body, {
      sex_at_birth: owner.sexAtBirth as ContextTemplatePerson['sex_at_birth'],
      age: ageOn(owner.birthDate, captureDateInZone(at, timezone)),
    });
    const row = (await tx.insert(contextSession).values({
      id: input.body.id, personId: input.body.person_id, scopeType: input.body.scope_type,
      scopeKey: input.body.scope_key, clientDocumentId: input.body.client_document_id,
      documentId: null, encounterId: input.body.encounter_id,
      templateId: input.body.template_id, templateVersion: input.body.template_version,
      templateHash: input.body.template_hash, questionSnapshot: input.body.question_snapshot,
      stage: input.body.stage, status: 'active', revision: 1,
      createdBy: input.accountId, createdAt: new Date(at), updatedBy: input.accountId,
      updatedAt: new Date(at), completedAt: null,
    }).returning())[0]!;
    const response = ContextSessionDetailResponse.parse({ session: contextSessionOut(row), answers: [] });
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'context_session_upsert', subjectType: 'context_session', subjectId: row.id,
      personId: row.personId, requestHash: replay.requestHash, request: input.body, result: response,
    });
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'context_session_upsert',
      event_id: input.body.client_operation_id, at, by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: owner.slug,
      subject_id: row.id, revision: row.revision, before: null, after: response.session,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response }, references: {},
    });
    return response;
  });
}

async function reprojectSessionAnswers(tx: Tx, session: ContextSessionRow, requestHash: string): Promise<void> {
  const answers = await tx.select().from(contextAnswer).where(eq(contextAnswer.sessionId, session.id));
  for (const answer of answers) await projectContextAnswer(tx, session, answer, requestHash);
}

export async function bindContextDocument(input: {
  sessionId: string; accountId: string; body: { client_operation_id: string; if_revision: number };
}) {
  return db.transaction(async (tx) => {
    const current = await lockSession(tx, input.sessionId);
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, current.personId)).limit(1))[0];
    if (!owner) throw notFound();
    const request = { session_id: input.sessionId, ...input.body };
    const replay = await replayOperation<ReturnType<typeof ContextSessionDetailResponse.parse>>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return ContextSessionDetailResponse.parse(replay.result);
    assertRevision(current, input.body.if_revision, input.body);
    if (current.scopeType !== 'document' || !current.clientDocumentId) {
      throw new ApiError('validation_failed', 'standalone session 不能绑定文档');
    }
    if (current.documentId) return sessionDetail(current.id, tx);
    const target = (await tx.select({ id: document.id, personId: document.personId }).from(document)
      .where(and(
        eq(document.uploadedBy, current.createdBy),
        eq(document.clientDocumentId, current.clientDocumentId),
      )).limit(1))[0];
    if (!target || target.personId !== current.personId) throw notFound();
    const at = serverTimestamp();
    const row = (await tx.update(contextSession).set({
      documentId: target.id, revision: current.revision + 1,
      updatedBy: input.accountId, updatedAt: new Date(at),
    }).where(eq(contextSession.id, current.id)).returning())[0]!;
    await reprojectSessionAnswers(tx, row, replay.requestHash);
    const response = await sessionDetail(row.id, tx);
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'context_session_upsert', subjectType: 'context_session', subjectId: row.id,
      personId: row.personId, requestHash: replay.requestHash, request, result: response,
    });
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'context_session_upsert',
      event_id: input.body.client_operation_id, at, by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: owner.slug,
      subject_id: row.id, revision: row.revision, before: contextSessionOut(current), after: response.session,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response }, references: {},
    });
    return response;
  });
}

function mediaUploadId(answer: ContextAnswerInputT): string | null {
  if (answer.skipped || (answer.answer_type !== 'audio' && answer.answer_type !== 'photo')) return null;
  if (!answer.value || typeof answer.value !== 'object' || !('upload_id' in answer.value)) return null;
  return typeof answer.value.upload_id === 'string' ? answer.value.upload_id : null;
}

function answerSearchText(row: ContextAnswerRow): string {
  if (row.skipped || row.uploadId) return '';
  const question = row.questionSnapshot as ContextQuestionT;
  if (row.answerType === 'choice' && typeof row.value === 'string') {
    return question.options.find((option) => option.value === row.value)?.label ?? row.value;
  }
  if (row.answerType === 'multi_choice' && Array.isArray(row.value)) {
    const labels = new Map(question.options.map((option) => [option.value, option.label]));
    return row.value.map((value) => labels.get(String(value)) ?? String(value)).join(' ');
  }
  return typeof row.value === 'string' || typeof row.value === 'number' ? String(row.value) : '';
}

async function projectContextAnswer(
  tx: Tx, session: ContextSessionRow, row: ContextAnswerRow, requestHash: string,
): Promise<void> {
  const body = answerSearchText(row).trim();
  if (!body) {
    await tx.delete(searchEntry).where(and(
      eq(searchEntry.entityType, 'context_answer'), eq(searchEntry.entityId, row.id),
    ));
    return;
  }
  const sortAt = row.eventAt ?? (row.eventOn ? new Date(`${row.eventOn}T00:00:00.000Z`) : row.answeredAt ?? session.createdAt);
  await tx.insert(searchEntry).values({
    id: row.id, personId: session.personId, entityType: 'context_answer', entityId: row.id,
    documentId: session.documentId, occurredOn: row.eventOn, sortAt,
    title: row.questionText, coreBody: body, sourceRevisionHash: requestHash,
  }).onConflictDoUpdate({
    target: [searchEntry.entityType, searchEntry.entityId],
    set: {
      documentId: session.documentId, occurredOn: row.eventOn, sortAt,
      title: row.questionText, coreBody: body, sourceRevisionHash: requestHash, updatedAt: new Date(),
    },
  });
}

export async function upsertContextAnswers(input: {
  sessionId: string; accountId: string;
  body: { client_operation_id: string; if_revision: number; answers: ContextAnswerInputT[] };
}) {
  return db.transaction(async (tx) => {
    const current = await lockSession(tx, input.sessionId);
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, current.personId)).limit(1))[0];
    if (!owner) throw notFound();
    const request = { session_id: input.sessionId, ...input.body };
    const replay = await replayOperation<ReturnType<typeof ContextSessionDetailResponse.parse>>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return ContextSessionDetailResponse.parse(replay.result);
    assertRevision(current, input.body.if_revision, input.body);
    if (current.status !== 'active') throw new ApiError('validation_failed', '已完成的情境记录不能继续编辑');
    const questions = new Map((current.questionSnapshot as ContextQuestionT[])
      .map((question) => [question.key, question]));
    for (const answer of input.body.answers) {
      const question = questions.get(answer.question_key);
      if (!question) throw new ApiError('validation_failed', `未知问题: ${answer.question_key}`);
      validateAnswerAgainstQuestion(answer, question);
    }
    const targetKeys = input.body.answers.map((answer) => answer.question_key);
    const priorRows = await tx.select().from(contextAnswer).where(and(
      eq(contextAnswer.sessionId, current.id), inArray(contextAnswer.questionKey, targetKeys),
    ));
    const priorByKey = new Map(priorRows.map((row) => [row.questionKey, row]));
    const uploadIds = input.body.answers.map(mediaUploadId).filter((id): id is string => id !== null);
    const uploads = uploadIds.length === 0 ? [] : await tx.select().from(contextUpload)
      .where(inArray(contextUpload.id, uploadIds));
    const uploadById = new Map(uploads.map((row) => [row.id, row]));
    const usedElsewhere = uploadIds.length === 0 ? [] : await tx.select({
      uploadId: contextAnswer.uploadId, questionKey: contextAnswer.questionKey,
    }).from(contextAnswer).where(and(
      eq(contextAnswer.sessionId, current.id), inArray(contextAnswer.uploadId, uploadIds),
    ));
    const timezone = await accountTimezone(tx, input.accountId);
    const sampled = current.documentId ? (await tx.select({ sampledOn: documentManualMetadata.sampledOn })
      .from(documentManualMetadata).where(eq(documentManualMetadata.documentId, current.documentId)).limit(1))[0]?.sampledOn ?? null : null;
    const at = serverTimestamp();
    const changed: ContextAnswerRow[] = [];
    for (const answer of input.body.answers) {
      const question = questions.get(answer.question_key)!;
      let uploadId: string | null = null;
      let storedValue: unknown = answer.skipped ? null : answer.value;
      if (!answer.skipped && (answer.answer_type === 'audio' || answer.answer_type === 'photo')) {
        uploadId = mediaUploadId(answer);
        if (!uploadId) throw new ApiError('validation_failed', `${answer.question_key} 缺少 upload_id`);
        storedValue = null;
        const upload = uploadById.get(uploadId);
        const alreadyUsed = usedElsewhere.find((item) => item.uploadId === uploadId && item.questionKey !== answer.question_key);
        if (!upload || upload.state !== 'finalized' || upload.sessionId !== current.id
            || upload.personId !== current.personId || upload.questionKey !== answer.question_key
            || upload.kind !== answer.answer_type || alreadyUsed) throw notFound();
      }
      const event = deriveContextEventTime({
        answer, question, timezone, sessionCreatedAt: current.createdAt, documentSampledOn: sampled,
      });
      const prior = priorByKey.get(answer.question_key);
      const values = {
        sessionId: current.id, questionKey: question.key, questionText: question.text,
        questionSnapshot: question, answerType: answer.answer_type, value: storedValue,
        uploadId, skipped: answer.skipped,
        answeredAt: answer.answered_at ? new Date(answer.answered_at) : new Date(at),
        eventOn: event.eventOn, eventAt: event.eventAt, timePrecision: event.precision,
        eventTimeSource: event.source, revision: (prior?.revision ?? 0) + 1,
        updatedBy: input.accountId, updatedAt: new Date(at),
      };
      const row = prior
        ? (await tx.update(contextAnswer).set(values).where(eq(contextAnswer.id, prior.id)).returning())[0]!
        : (await tx.insert(contextAnswer).values({ id: uuidv7(), ...values }).returning())[0]!;
      changed.push(row);
    }
    const sessionAfter = (await tx.update(contextSession).set({
      revision: current.revision + 1, updatedBy: input.accountId, updatedAt: new Date(at),
    }).where(eq(contextSession.id, current.id)).returning())[0]!;
    for (const row of changed) await projectContextAnswer(tx, sessionAfter, row, replay.requestHash);
    const response = await sessionDetail(current.id, tx);
    const before = priorRows.map(contextAnswerOut);
    const after = changed.map(contextAnswerOut);
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'context_answer_upsert', subjectType: 'context_session', subjectId: current.id,
      personId: current.personId, requestHash: replay.requestHash, request, result: response,
    });
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'context_answer_upsert',
      event_id: input.body.client_operation_id, at, by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: owner.slug,
      subject_id: current.id, revision: sessionAfter.revision, before, after,
      session_after: response.session,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response }, references: {},
    });
    return response;
  });
}

export async function completeContextSession(input: {
  sessionId: string; accountId: string; body: { client_operation_id: string; if_revision: number };
}) {
  return db.transaction(async (tx) => {
    const current = await lockSession(tx, input.sessionId);
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, current.personId)).limit(1))[0];
    if (!owner) throw notFound();
    const request = { session_id: input.sessionId, ...input.body };
    const replay = await replayOperation<ReturnType<typeof ContextSessionDetailResponse.parse>>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    if (replay.result) return ContextSessionDetailResponse.parse(replay.result);
    assertRevision(current, input.body.if_revision, input.body);
    if (current.status === 'completed') return sessionDetail(current.id, tx);
    const at = serverTimestamp();
    const row = (await tx.update(contextSession).set({
      status: 'completed', completedAt: new Date(at), revision: current.revision + 1,
      updatedBy: input.accountId, updatedAt: new Date(at),
    }).where(eq(contextSession.id, current.id)).returning())[0]!;
    const response = await sessionDetail(row.id, tx);
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id,
      kind: 'context_session_upsert', subjectType: 'context_session', subjectId: row.id,
      personId: row.personId, requestHash: replay.requestHash, request, result: response,
    });
    await appendJournal(tx, owner.slug, {
      schema_version: '1.0', event: 'context_session_upsert',
      event_id: input.body.client_operation_id, at, by_account_id: input.accountId,
      client_operation_id: input.body.client_operation_id, person_slug: owner.slug,
      subject_id: row.id, revision: row.revision, before: contextSessionOut(current), after: response.session,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: response }, references: {},
    });
    return response;
  });
}

export async function listPendingContext(input: {
  accountId: string; personId: string; localDate: string; cursor?: string; limit: number;
}) {
  const timezone = await accountTimezone(db, input.accountId);
  const conditions = [
    eq(contextSession.personId, input.personId), eq(contextSession.status, 'active'),
    eq(contextSession.stage, 'same_day'),
    sql`(${contextSession.createdAt} at time zone ${timezone})::date = ${input.localDate}::date`,
  ];
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor, input.personId, input.localDate);
    conditions.push(or(
      lt(contextSession.createdAt, cursor.createdAt),
      and(eq(contextSession.createdAt, cursor.createdAt), lt(contextSession.id, cursor.id)),
    )!);
  }
  const rows = await db.select().from(contextSession).where(and(...conditions))
    .orderBy(desc(contextSession.createdAt), desc(contextSession.id)).limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return ContextPendingResponse.parse({
    sessions: page.map(contextSessionOut),
    next_cursor: rows.length > input.limit && last
      ? encodeCursor(last.createdAt, last.id, input.personId, input.localDate) : null,
  });
}
