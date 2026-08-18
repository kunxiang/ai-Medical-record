import { sql } from 'drizzle-orm';
import {
  bigint, check, date, index, integer, jsonb, numeric, pgTable, primaryKey,
  text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import {
  AccessRole, DocType, DocumentSource, DocumentStatus, EncounterType,
  IdentifierScope, IdentifierType, RelationToOwner, SexAtBirth,
} from '@amr/contracts';

// spec m0-02。枚举 CHECK 的值列表由 contracts 生成 —— 单一来源(B2 由构造保证 + 集成断言)。
const inList = (col: string, values: readonly string[]) =>
  sql.raw(`${col} in (${values.map((v) => `'${v}'`).join(', ')})`);

export const account = pgTable('account', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  timezone: text('timezone').notNull().default('Asia/Shanghai'),
  tokenEpoch: integer('token_epoch').notNull().default(0),   // D12:改密码递增 ⇒ 旧 token 失效
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const person = pgTable(
  'person',
  {
    id: uuid('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    displayName: text('display_name').notNull(),
    namePinyin: text('name_pinyin'),
    birthDate: date('birth_date').notNull(),
    sexAtBirth: text('sex_at_birth').notNull(),
    gender: text('gender'),
    relationToOwner: text('relation_to_owner').notNull(),
    bloodType: text('blood_type'),
    allergies: jsonb('allergies').notNull().default(sql`'[]'::jsonb`),
    chronicConditions: jsonb('chronic_conditions').notNull().default(sql`'[]'::jsonb`),
    note: text('note').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    check('person_sex_at_birth', inList('sex_at_birth', SexAtBirth.options)),
    check('person_relation', inList('relation_to_owner', RelationToOwner.options)),
  ],
);

export const facility = pgTable('facility', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
  slug: text('slug').notNull(),
  city: text('city'),
  level: text('level'),
});

export const personIdentifier = pgTable(
  'person_identifier',
  {
    id: uuid('id').primaryKey(),
    personId: uuid('person_id').notNull().references(() => person.id),
    facilityId: uuid('facility_id').references(() => facility.id),
    identifierType: text('identifier_type').notNull(),
    identifierValue: text('identifier_value').notNull(),
    scope: text('scope').notNull(),
  },
  (t) => [
    check('pi_type', inList('identifier_type', IdentifierType.options)),
    check('pi_scope', inList('scope', IdentifierScope.options)),
    uniqueIndex('uq_person_identifier').on(
      sql`COALESCE(${t.facilityId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.identifierType,
      t.identifierValue,
    ),
  ],
);

export const personAccess = pgTable(
  'person_access',
  {
    accountId: uuid('account_id').notNull().references(() => account.id),
    personId: uuid('person_id').notNull().references(() => person.id),
    role: text('role').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.personId] }),
    check('pa_role', inList('role', AccessRole.options)),
  ],
);

export const encounter = pgTable(
  'encounter',
  {
    id: uuid('id').primaryKey(),
    personId: uuid('person_id').notNull().references(() => person.id),
    encounterType: text('encounter_type').notNull(),
    facilityId: uuid('facility_id').references(() => facility.id),
    department: text('department'),
    occurredOn: date('occurred_on').notNull(),
    endedOn: date('ended_on'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    chiefComplaint: text('chief_complaint').notNull().default(''),
    diagnosisText: text('diagnosis_text').notNull().default(''),
    doctorAdvice: text('doctor_advice').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('enc_type', inList('encounter_type', EncounterType.options))],
);

export const document = pgTable(
  'document',
  {
    id: uuid('id').primaryKey(),
    shortId: text('short_id').notNull().unique(),
    personId: uuid('person_id').notNull().references(() => person.id),
    encounterId: uuid('encounter_id').references(() => encounter.id),
    docType: text('doc_type').notNull().default('unknown'),
    docTypeConfidence: numeric('doc_type_confidence'),
    pageCount: integer('page_count').notNull(),
    source: text('source').notNull(),
    originalFilename: text('original_filename'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    captureDate: date('capture_date').notNull(),
    // AI/提取相关列:M0 建出恒 NULL(spec m0-02)
    sampledOn: date('sampled_on'),
    reportedOn: date('reported_on'),
    collectedAt: timestamp('collected_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    testedAt: timestamp('tested_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    eventTime: timestamp('event_time', { withTimezone: true }),
    eventTimeSource: text('event_time_source'),
    examItems: jsonb('exam_items'),
    facilityId: uuid('facility_id').references(() => facility.id),
    reportNo: text('report_no'),
    accessionNo: text('accession_no'),
    visitNo: text('visit_no'),
    specimen: text('specimen'),
    specimenLabel: text('specimen_label'),
    panelName: text('panel_name'),
    orderingDoctor: text('ordering_doctor'),
    clinicalDiagnosis: text('clinical_diagnosis'),
    performedBy: text('performed_by'),
    verifiedByName: text('verified_by_name'),
    reportNotes: text('report_notes'),
    reportNotesSource: text('report_notes_source').notNull().default('report_original'),
    columnSet: jsonb('column_set'),
    uploadedBy: uuid('uploaded_by').notNull().references(() => account.id),
    status: text('status').notNull(),
    clientDocumentId: text('client_document_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('doc_page_count', sql`page_count >= 1`),
    check('doc_source', inList('source', DocumentSource.options)),
    check('doc_status', inList('status', DocumentStatus.options)),
    check('doc_type_enum', inList('doc_type', DocType.options)),
    uniqueIndex('uq_document_idempotency').on(t.uploadedBy, t.clientDocumentId),
    index('idx_document_person_captured').on(t.personId, t.capturedAt.desc(), t.id.desc()),
  ],
);

export const documentPage = pgTable(
  'document_page',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id').notNull().references(() => document.id),
    pageNo: integer('page_no').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    contentSha256: text('content_sha256').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    mimeType: text('mime_type').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    thumbKey: text('thumb_key'),
    pageLabel: text('page_label'),
    captureOrder: integer('capture_order').notNull(),
  },
  (t) => [
    check('dp_page_no', sql`page_no >= 1`),
    uniqueIndex('uq_document_page').on(t.documentId, t.pageNo),
  ],
);

export const uploadBatch = pgTable('upload_batch', {
  id: uuid('id').primaryKey(),
  docShortId: text('doc_short_id').notNull().unique(),
  personId: uuid('person_id').notNull().references(() => person.id),
  createdBy: uuid('created_by').notNull().references(() => account.id),
  consumedByDocumentId: uuid('consumed_by_document_id').references(() => document.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const uploadFile = pgTable('upload_file', {
  id: uuid('id').primaryKey(),
  batchId: uuid('batch_id').notNull().references(() => uploadBatch.id),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  incomingKey: text('incoming_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 放弃上报的幂等台账(m1-99 A8):discard_event_id 由客户端持久化,重放只应产生一行 journal。
 *  这是 L2 结构 —— 删库重建后台账为空,重放窗口内可能补出第二行;
 *  journal 回放(D16,M3)落地后该台账可由 L1 自身重建,届时本表退化为缓存(D17)。 */
export const captureDiscardEvent = pgTable('capture_discard_event', {
  id: uuid('id').primaryKey(),                       // == discard_event_id
  personId: uuid('person_id').notNull().references(() => person.id),
  clientDocumentId: uuid('client_document_id').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});
