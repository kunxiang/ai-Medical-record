import { and, eq, sql } from 'drizzle-orm';
import {
  DocumentManualMetadataSnapshot, DocumentMetadataMutationResponse,
  ManualMetadataField, type DocumentMetadataPatchT, type EffectiveDocumentMetadataT,
} from '@amr/contracts';
import { serverTimestamp } from '@amr/storage';
import { db, type Tx } from '../db/client.js';
import {
  document, documentManualMetadata, facility, person, searchEntry,
} from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { appendJournal } from '../journal.js';
import { recordOperation, replayOperation } from './operation-ledger.js';

type Provenance = Record<string, {
  source: 'manual' | 'accepted_suggestion'; event_id: string; suggestion_id?: string | null;
}>;

function hasField(value: object, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

export function effectiveMetadata(input: {
  manual: {
    docType: string | null; sampledOn: string | null; reportedOn: string | null;
    facilityName: string | null; department: string | null; title: string | null; note: string | null;
    provenance: Provenance;
  } | null;
  fallback: { facilityName: string | null; title: string | null };
}): EffectiveDocumentMetadataT {
  const field = <T>(name: string, manual: T | null, fallback: T | null) => {
    const p = input.manual?.provenance[name];
    return p
      ? { value: manual, source: p.source, suggestion_id: p.suggestion_id ?? null }
      : { value: fallback, source: 'capture_fallback' as const, suggestion_id: null };
  };
  const facilityProvenance = input.manual?.provenance.facility_id
    ? 'facility_id' : 'facility_name_raw';
  return {
    doc_type: field('doc_type', input.manual?.docType ?? null, 'unknown'),
    sampled_on: field('sampled_on', input.manual?.sampledOn ?? null, null),
    reported_on: field('reported_on', input.manual?.reportedOn ?? null, null),
    facility_name: field(
      facilityProvenance, input.manual?.facilityName ?? null, input.fallback.facilityName,
    ),
    department: field('department', input.manual?.department ?? null, null),
    title: field('title', input.manual?.title ?? null, input.fallback.title),
    note: field('note', input.manual?.note ?? null, null),
  } as EffectiveDocumentMetadataT;
}

type MetadataMutationResponse = ReturnType<typeof DocumentMetadataMutationResponse.parse>;
type MetadataSnapshot = ReturnType<typeof DocumentManualMetadataSnapshot.parse>;

export async function mutateDocumentMetadata<Result = MetadataMutationResponse>(input: {
  documentId: string;
  accountId: string;
  patch: DocumentMetadataPatchT;
  tx?: Tx;
  attribution?: {
    source: 'manual' | 'accepted_suggestion';
    suggestionId: string | null;
    suggestionSnapshot: Record<string, unknown> | null;
  };
  buildResult?: (input: {
    response: MetadataMutationResponse;
    before: MetadataSnapshot | null;
    after: MetadataSnapshot;
  }) => Result;
  requestOverride?: Record<string, unknown>;
}) {
  const execute = async (tx: Tx) => {
    const context = (await tx.select({
      id: document.id, personId: document.personId, personSlug: person.slug,
      capturedAt: document.capturedAt, captureDate: document.captureDate,
      originalFilename: document.originalFilename,
    }).from(document).innerJoin(person, eq(person.id, document.personId))
      .where(eq(document.id, input.documentId)).limit(1).for('update'))[0];
    if (!context) throw notFound();

    const request = input.requestOverride ?? { document_id: input.documentId, ...input.patch };
    const replay = await replayOperation<Result>(tx, {
      accountId: input.accountId,
      clientOperationId: input.patch.client_operation_id,
      request,
    });
    if (replay.result) {
      return { result: replay.result, replayed: true, before: null, after: null };
    }

    const current = (await tx.select().from(documentManualMetadata)
      .where(eq(documentManualMetadata.documentId, input.documentId)).limit(1).for('update'))[0] ?? null;
    const currentRevision = current?.revision ?? 0;
    if (input.patch.if_revision !== currentRevision) {
      throw new ApiError('revision_conflict', '文档元数据已被其他操作更新', {
        base_revision: input.patch.if_revision,
        current: current ? {
          revision: current.revision,
          doc_type: current.docType,
          sampled_on: current.sampledOn,
          reported_on: current.reportedOn,
          facility_id: current.facilityId,
          facility_name_raw: current.facilityNameRaw,
          department: current.department,
          title: current.title,
          note: current.note,
          field_provenance: current.fieldProvenance,
        } : {
          revision: 0,
          doc_type: null,
          sampled_on: null,
          reported_on: null,
          facility_id: null,
          facility_name_raw: null,
          department: null,
          title: null,
          note: null,
          field_provenance: {},
        },
        draft: input.patch,
      });
    }

    let facilitySnapshot: {
      id: string; slug: string; name: string; aliases: string[]; city: string | null; level: string | null;
    } | null = null;
    if (hasField(input.patch, 'facility_id') && input.patch.facility_id) {
      facilitySnapshot = (await tx.select().from(facility)
        .where(eq(facility.id, input.patch.facility_id)).limit(1))[0] ?? null;
      if (!facilitySnapshot) throw notFound();
    } else if (!hasField(input.patch, 'facility_id') && current?.facilityId) {
      facilitySnapshot = (await tx.select().from(facility)
        .where(eq(facility.id, current.facilityId)).limit(1))[0] ?? null;
    }

    const provenance = { ...((current?.fieldProvenance ?? {}) as Provenance) };
    for (const field of ManualMetadataField.options) {
      if (hasField(input.patch, field)) {
        provenance[field] = {
          source: input.attribution?.source ?? 'manual',
          event_id: input.patch.client_operation_id,
          suggestion_id: input.attribution?.suggestionId ?? null,
        };
      }
    }
    const at = serverTimestamp();
    const values = {
      documentId: input.documentId,
      docType: hasField(input.patch, 'doc_type') ? input.patch.doc_type ?? null : current?.docType ?? null,
      sampledOn: hasField(input.patch, 'sampled_on') ? input.patch.sampled_on ?? null : current?.sampledOn ?? null,
      reportedOn: hasField(input.patch, 'reported_on') ? input.patch.reported_on ?? null : current?.reportedOn ?? null,
      facilityId: hasField(input.patch, 'facility_id') ? input.patch.facility_id ?? null : current?.facilityId ?? null,
      facilityNameRaw: hasField(input.patch, 'facility_name_raw')
        ? input.patch.facility_name_raw ?? null : current?.facilityNameRaw ?? null,
      department: hasField(input.patch, 'department') ? input.patch.department ?? null : current?.department ?? null,
      title: hasField(input.patch, 'title') ? input.patch.title ?? null : current?.title ?? null,
      note: hasField(input.patch, 'note') ? input.patch.note ?? null : current?.note ?? null,
      fieldProvenance: provenance,
      revision: currentRevision + 1,
      updatedBy: input.accountId,
      updatedAt: new Date(at),
    };
    const saved = (await tx.insert(documentManualMetadata).values(values).onConflictDoUpdate({
      target: documentManualMetadata.documentId,
      set: values,
    }).returning())[0]!;

    const manualFacilityName = saved.facilityId
      ? facilitySnapshot?.name ?? null : saved.facilityNameRaw;
    const effective = effectiveMetadata({
      manual: {
        docType: saved.docType, sampledOn: saved.sampledOn, reportedOn: saved.reportedOn,
        facilityName: manualFacilityName, department: saved.department,
        title: saved.title, note: saved.note, provenance,
      },
      fallback: { facilityName: null, title: context.originalFilename },
    });
    const response = DocumentMetadataMutationResponse.parse({
      document_id: context.id, revision: saved.revision,
      effective_metadata: effective, field_provenance: provenance,
    });
    const snapshot = DocumentManualMetadataSnapshot.parse({
      document_id: saved.documentId, doc_type: saved.docType,
      sampled_on: saved.sampledOn, reported_on: saved.reportedOn,
      facility_id: saved.facilityId, facility_name_raw: saved.facilityNameRaw,
      department: saved.department, title: saved.title, note: saved.note,
      field_provenance: provenance, revision: saved.revision,
      updated_by: saved.updatedBy, updated_at: saved.updatedAt.toISOString(),
    });
    const before = current ? DocumentManualMetadataSnapshot.parse({
      document_id: current.documentId, doc_type: current.docType,
      sampled_on: current.sampledOn, reported_on: current.reportedOn,
      facility_id: current.facilityId, facility_name_raw: current.facilityNameRaw,
      department: current.department, title: current.title, note: current.note,
      field_provenance: current.fieldProvenance, revision: current.revision,
      updated_by: current.updatedBy, updated_at: current.updatedAt.toISOString(),
    }) : null;

    const coreBody = [
      context.originalFilename, effective.title.value, effective.facility_name.value,
      effective.department.value, effective.note.value,
    ].filter(Boolean).join('\n');
    await tx.insert(searchEntry).values({
      id: context.id, personId: context.personId, entityType: 'document', entityId: context.id,
      documentId: context.id, occurredOn: saved.sampledOn ?? saved.reportedOn ?? context.captureDate,
      sortAt: context.capturedAt, title: effective.title.value ?? context.originalFilename ?? '医疗记录',
      coreBody, sourceRevisionHash: replay.requestHash,
    }).onConflictDoUpdate({
      target: [searchEntry.entityType, searchEntry.entityId],
      set: {
        occurredOn: saved.sampledOn ?? saved.reportedOn ?? context.captureDate,
        sortAt: context.capturedAt, title: effective.title.value ?? context.originalFilename ?? '医疗记录',
        coreBody, sourceRevisionHash: replay.requestHash, updatedAt: new Date(at),
      },
    });
    const result = input.buildResult?.({ response, before, after: snapshot }) ?? response as Result;
    await recordOperation(tx, {
      accountId: input.accountId, clientOperationId: input.patch.client_operation_id,
      kind: 'document_metadata_upsert', subjectType: 'document', subjectId: context.id,
      personId: context.personId, requestHash: replay.requestHash, request, result,
    });
    await appendJournal(tx, context.personSlug, {
      schema_version: '1.0', event: 'document_metadata_upsert',
      event_id: input.patch.client_operation_id, at, by_account_id: input.accountId,
      client_operation_id: input.patch.client_operation_id, person_slug: context.personSlug,
      subject_id: context.id, revision: saved.revision, before, after: snapshot,
      operation_replay: { request_hash: replay.requestHash, response_snapshot: result as Record<string, unknown> },
      references: { facility: facilitySnapshot, suggestion: input.attribution?.suggestionSnapshot ?? null },
    });
    return { result, replayed: false, before, after: snapshot };
  };
  return input.tx ? execute(input.tx) : db.transaction(execute);
}

export async function patchDocumentMetadata(input: {
  documentId: string; accountId: string; patch: DocumentMetadataPatchT;
}) {
  return DocumentMetadataMutationResponse.parse((await mutateDocumentMetadata(input)).result);
}
