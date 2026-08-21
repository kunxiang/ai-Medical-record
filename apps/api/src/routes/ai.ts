import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AiJobListQuery, AiJobListResponse, AiRerunRequest, AiRerunResponse,
  Uuid, decodeCursor, encodeCursor,
} from '@amr/contracts';
import { requireDocumentAccess } from '../access.js';
import { db } from '../db/client.js';
import { aiJob, document, person, personAccess } from '../db/schema.js';
import { defineRoute } from '../define-route.js';
import { ApiError, notFound } from '../errors.js';
import { resetForRerun } from '../jobs/queue.js';

// spec m2-04 §5。三个端点,全部经 defineRoute 与既有鉴权;越权一律 404 且与不存在不可区分。

const DocAiResponse = z.object({
  document_id: Uuid,
  doc_type: z.string(),
  doc_type_confidence: z.number().nullable(),
  sampled_on: z.string().nullable(),
  reported_on: z.string().nullable(),
  department_raw: z.string().nullable(),
  person_check: z.string(),
  person_check_ack_at: z.string().nullable(),
  s1_artifact_key: z.string().nullable(),
  s1_prompt_version: z.number().nullable(),
  jobs: z.array(z.object({
    kind: z.string(), state: z.string(), attempt: z.number(),
    last_error: z.unknown().nullable(), updated_at: z.string(),
  })),
});

export function registerAiRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/documents/:id/ai',
    input: z.object({ id: Uuid }),
    output: DocAiResponse,
    handler: async ({ input, accountId }) => {
      await requireDocumentAccess(accountId, input.id, 'viewer');
      const d = (await db.select().from(document).where(eq(document.id, input.id)).limit(1))[0];
      if (!d) throw notFound();
      const jobs = await db.select().from(aiJob).where(eq(aiJob.documentId, input.id)).orderBy(desc(aiJob.updatedAt));
      // ★ 禁止返回 full_text(m2-04 §5.4):它只在 L2 工件里,经 API 外泄没有任何理由
      return {
        document_id: d.id,
        doc_type: d.docType,
        doc_type_confidence: d.docTypeConfidence === null ? null : Number(d.docTypeConfidence),
        sampled_on: d.sampledOn, reported_on: d.reportedOn,
        department_raw: d.departmentRaw,
        person_check: d.personCheck,
        person_check_ack_at: d.personCheckAckAt?.toISOString() ?? null,
        s1_artifact_key: d.s1ArtifactKey, s1_prompt_version: d.s1PromptVersion,
        jobs: jobs.map((j) => ({
          kind: j.kind, state: j.state, attempt: j.attempt,
          last_error: j.lastError, updated_at: j.updatedAt.toISOString(),
        })),
      };
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/jobs',
    input: AiJobListQuery,
    output: AiJobListResponse,
    handler: async ({ input, accountId }) => {
      // 可见性(m2-04 §5.3b):绑人的作业按 person_access 过滤;
      // 家庭级作业(person_id 为 NULL)对"有任一 editor 权限"的账号可见,
      // 且其载荷本就不含 person/document 标识。
      const editable = db
        .select({ pid: personAccess.personId })
        .from(personAccess)
        .where(and(eq(personAccess.accountId, accountId), sql`${personAccess.role} in ('owner','editor')`));
      const conds = [
        or(sql`${aiJob.personId} is null`, sql`${aiJob.personId} in ${editable}`)!,
      ];
      if (input.state) conds.push(eq(aiJob.state, input.state));
      if (input.kind) conds.push(eq(aiJob.kind, input.kind));
      if (input.cursor) {
        let c: { capturedAt: string; documentId: string };
        try { c = decodeCursor(input.cursor); } catch { throw new ApiError('validation_failed', '游标无效'); }
        conds.push(or(
          lt(aiJob.updatedAt, new Date(c.capturedAt)),
          and(eq(aiJob.updatedAt, new Date(c.capturedAt)), lt(aiJob.id, c.documentId)),
        )!);
      }
      const rows = await db.select().from(aiJob).where(and(...conds))
        .orderBy(desc(aiJob.updatedAt), desc(aiJob.id)).limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        jobs: page.map((j) => ({
          id: j.id, kind: j.kind as never, state: j.state as never,
          document_id: j.documentId, person_id: j.personId,
          attempt: j.attempt, next_attempt_at: j.nextAttemptAt.toISOString(),
          last_error: (j.lastError as never) ?? null, result_key: j.resultKey,
          created_at: j.createdAt.toISOString(), updated_at: j.updatedAt.toISOString(),
        })),
        next_cursor: rows.length > input.limit && last
          ? encodeCursor(last.updatedAt.toISOString(), last.id) : null,
      };
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/documents/:id/ai/rerun',
    input: AiRerunRequest.extend({ id: Uuid }),
    output: AiRerunResponse,
    handler: async ({ input, accountId }) => {
      // 一次只作用于一个文档 —— 批量补跑由 tools/ 侧脚本负责,不开放为 API(m2-04 §5.3)
      await requireDocumentAccess(accountId, input.id, 'editor');
      const j = (await db.select().from(aiJob)
        .where(and(eq(aiJob.documentId, input.id), eq(aiJob.kind, input.kind))).limit(1))[0];
      if (!j) throw notFound();
      await resetForRerun(j.id);
      return { job_id: j.id, state: 'pending' as const };
    },
  });
}
