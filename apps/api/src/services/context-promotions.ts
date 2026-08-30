import { eq } from 'drizzle-orm';
import {
  ContextAnswerPromoteResponse, ContextQuestion, MedicationBatchCreateRequest,
  MedicationBatchCreateResponse, ObservationBatchCreateRequest, ObservationBatchCreateResponse,
  type ContextAnswerPromoteRequestT,
} from '@amr/contracts';
import { db } from '../db/client.js';
import { contextAnswer, contextSession, person } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { persistMedicationBatch } from './medications.js';
import { persistObservationBatch } from './observations.js';
import { replayOperation } from './operation-ledger.js';

function assertPromotionTarget(
  questionRaw: unknown, targetType: ContextAnswerPromoteRequestT['target_type'],
): void {
  const question = ContextQuestion.parse(questionRaw);
  const mapped = question.maps_to ?? '';
  const allowed = targetType === 'observation'
    ? mapped.startsWith('observation')
    : mapped.startsWith('medication') || question.timeline_kind === 'medication_change';
  if (!allowed) {
    throw new ApiError('validation_failed', '该问题没有对应的结构化事实目标');
  }
}

export async function contextAnswerPersonId(answerId: string): Promise<string> {
  const row = (await db.select({ personId: contextSession.personId }).from(contextAnswer)
    .innerJoin(contextSession, eq(contextSession.id, contextAnswer.sessionId))
    .where(eq(contextAnswer.id, answerId)).limit(1))[0];
  if (!row) throw notFound();
  return row.personId;
}

export async function promoteContextAnswer(input: {
  answerId: string; accountId: string; body: ContextAnswerPromoteRequestT;
}) {
  return db.transaction(async (tx) => {
    const answer = (await tx.select().from(contextAnswer).where(eq(contextAnswer.id, input.answerId))
      .limit(1).for('update'))[0];
    if (!answer) throw notFound();
    const session = (await tx.select().from(contextSession)
      .where(eq(contextSession.id, answer.sessionId)).limit(1))[0];
    if (!session) throw notFound();
    const owner = (await tx.select({ slug: person.slug }).from(person)
      .where(eq(person.id, session.personId)).limit(1).for('update'))[0];
    if (!owner) throw notFound();
    if (answer.skipped) throw new ApiError('validation_failed', '已跳过的答案不能提升为结构化事实');
    assertPromotionTarget(answer.questionSnapshot, input.body.target_type);
    const request = { answer_id: input.answerId, ...input.body };
    const replay = await replayOperation<unknown>(tx, {
      accountId: input.accountId, clientOperationId: input.body.client_operation_id, request,
    });
    const sourceRef = {
      context_answer_id: answer.id,
      context_session_id: session.id,
      question_key: answer.questionKey,
      answer_revision: answer.revision,
      promoted_explicitly: true,
    };
    if (input.body.target_type === 'medication') {
      const batch = MedicationBatchCreateRequest.parse({
        client_operation_id: input.body.client_operation_id, medications: [input.body.draft],
      });
      const result = replay.result
        ? MedicationBatchCreateResponse.parse(replay.result)
        : await persistMedicationBatch({
            tx, personId: session.personId, accountId: input.accountId, ownerSlug: owner.slug,
            body: batch, request, requestHash: replay.requestHash,
            sourceRefs: new Map([[input.body.draft.client_row_id, sourceRef]]),
          });
      return ContextAnswerPromoteResponse.parse({
        source_answer_id: answer.id, target_type: 'medication',
        medication: result.medications[0], warnings: result.warnings,
      });
    }
    const batch = ObservationBatchCreateRequest.parse({
      client_operation_id: input.body.client_operation_id,
      defaults: input.body.defaults,
      observations: [input.body.draft],
    });
    const result = replay.result
      ? ObservationBatchCreateResponse.parse(replay.result)
      : await persistObservationBatch({
          tx, personId: session.personId, accountId: input.accountId, ownerSlug: owner.slug,
          body: batch, request, requestHash: replay.requestHash,
          sourceRefs: new Map([[input.body.draft.client_row_id, sourceRef]]),
        });
    return ContextAnswerPromoteResponse.parse({
      source_answer_id: answer.id, target_type: 'observation',
      observation: result.observations[0], warnings: result.warnings,
    });
  });
}
