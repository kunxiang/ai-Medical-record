import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, date, index, integer, jsonb, numeric, pgTable, primaryKey,
  text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import {
  AccessRole, AiJobKind, AiJobState, DocType, DocumentSource, DocumentStatus, EncounterType,
  ContextAnswerType, ContextEventTimeSource, ContextMediaKind, ContextMediaMime,
  ContextScopeType, ContextSessionStatus, ContextStage, ContextUploadState,
  GroupingBasis, IdentifierScope, IdentifierType, NormalizationKind, NormalizationState,
  ObservationAbnormalFlag, ObservationComparator, ObservationDateSource,
  ObservationResultKind, ObservationReviewStatus, ObservationSource, ObservationTimePrecision,
  MetricGroupPreset,
  MedicationKind, MedicationSource, TimelineEventKind, ClinicalTimePrecision,
  PersonCheck, ProcessingCapability, ProcessingJobState, ProcessingSubjectType,
  ProcessingSuggestionState, RelationToOwner, SearchEntityType, SexAtBirth,
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
  archivedAt: timestamp('archived_at', { withTimezone: true }),
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
    revision: integer('revision').notNull().default(1),
    updatedBy: uuid('updated_by').references(() => account.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /** ★ L1 人工层:归组判据强度(m2-05 §3)。可空 —— NULL 表示 M2 之前建的 encounter。
     *  它记的是"这一组是靠时分还是靠相邻日判出来的",与 document.event_time_source
     *  (该时刻取自哪个字段,docs/03 §226)是两件事,不能挤在一个列名里。 */
    groupingBasis: text('grouping_basis'),
  },
  (t) => [
    check('enc_type', inList('encounter_type', EncounterType.options)),
    check('enc_grouping_basis', sql`grouping_basis is null or ${inList('grouping_basis', GroupingBasis.options)}`),
    check('enc_revision', sql`revision >= 1`),
    index('idx_encounter_person_occurred').on(t.personId, t.occurredOn.desc(), t.id.desc()),
  ],
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
    // ── M2(spec m2-01 §5)。层的标注不是注释,是规范性约束:
    //    verify-rebuild 的字段表必须含全部 L1 人工层列、排除全部 L2 可重算列(m2-99 B13)。
    facilityNameRaw: text('facility_name_raw'),                               // L2 可重算
    departmentRaw: text('department_raw'),                                   // L2 可重算
    personCheck: text('person_check').notNull().default('unknown'),          // L2 可重算
    /** ★ L1 人工层:归人告警的 ack。**禁止**被任何重算写入或清除 —— 
     *  原设计让 ack 置 person_check='skipped',而 S1 每次重跑都会覆盖那一列(审核 #004 A-5)。 */
    personCheckAckAt: timestamp('person_check_ack_at', { withTimezone: true }),
    /** ★ L1 人工层:软删除 */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    s1ArtifactKey: text('s1_artifact_key'),                                  // L2 可重算
    s1PromptVersion: integer('s1_prompt_version'),                           // L2 可重算
    uploadedBy: uuid('uploaded_by').notNull().references(() => account.id),
    status: text('status').notNull(),
    clientDocumentId: text('client_document_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // merge 后被吸收文档保留为 0 页软归档记录，供审计与 correction 回放定位。
    check('doc_page_count', sql`page_count >= 0`),
    check('doc_source', inList('source', DocumentSource.options)),
    check('doc_status', inList('status', DocumentStatus.options)),
    check('doc_type_enum', inList('doc_type', DocType.options)),
    check('doc_person_check', inList('person_check', PersonCheck.options)),
    uniqueIndex('uq_document_idempotency').on(t.uploadedBy, t.clientDocumentId),
    index('idx_document_person_captured').on(t.personId, t.capturedAt.desc(), t.id.desc()),
    index('idx_document_person_capture_date').on(t.personId, t.captureDate.desc(), t.capturedAt.desc(), t.id.desc()),
    index('idx_document_person_sampled').on(t.personId, t.sampledOn.desc(), t.capturedAt.desc(), t.id.desc()),
    index('idx_document_person_reported').on(t.personId, t.reportedOn.desc(), t.capturedAt.desc(), t.id.desc()),
    index('idx_document_encounter').on(t.encounterId, t.capturedAt.desc(), t.id.desc()),
  ],
);

/** P0 L1：人工或已接受建议形成的逐字段事实。 */
export const documentManualMetadata = pgTable(
  'document_manual_metadata',
  {
    documentId: uuid('document_id').primaryKey().references(() => document.id),
    docType: text('doc_type'),
    sampledOn: date('sampled_on'),
    reportedOn: date('reported_on'),
    facilityId: uuid('facility_id').references(() => facility.id),
    facilityNameRaw: text('facility_name_raw'),
    department: text('department'),
    title: text('title'),
    note: text('note'),
    fieldProvenance: jsonb('field_provenance').notNull().default(sql`'{}'::jsonb`),
    revision: integer('revision').notNull().default(1),
    updatedBy: uuid('updated_by').notNull().references(() => account.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('dmm_doc_type', sql`doc_type is null or ${inList('doc_type', DocType.options)}`),
    check('dmm_revision', sql`revision >= 1`),
    check('dmm_facility_name_length', sql`facility_name_raw is null or char_length(facility_name_raw) <= 300`),
    check('dmm_department_length', sql`department is null or char_length(department) <= 200`),
    check('dmm_title_length', sql`title is null or char_length(title) <= 300`),
    check('dmm_note_length', sql`note is null or char_length(note) <= 4000`),
    index('idx_dmm_sampled').on(t.sampledOn, t.documentId),
    index('idx_dmm_reported').on(t.reportedOn, t.documentId),
    index('idx_dmm_facility').on(t.facilityId),
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
    originCaptureDocumentId: uuid('origin_capture_document_id').notNull(),
    originCaptureOrder: integer('origin_capture_order').notNull(),
    originObjectSha256: text('origin_object_sha256').notNull(),
  },
  (t) => [
    check('dp_page_no', sql`page_no >= 1`),
    check('dp_origin_capture_order', sql`origin_capture_order >= 1`),
    check('dp_origin_object_sha', sql`origin_object_sha256 ~ '^[0-9a-f]{64}$'`),
    uniqueIndex('uq_document_page').on(t.documentId, t.pageNo),
    uniqueIndex('uq_document_page_origin').on(
      t.originCaptureDocumentId, t.originCaptureOrder, t.originObjectSha256,
    ),
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
  /** >8 MiB 文件只有 complete 后 GET 回流 sha256 通过才置值；登记路由据此强制 multipart。 */
  multipartVerifiedAt: timestamp('multipart_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const multipartUpload = pgTable(
  'multipart_upload',
  {
    id: text('id').primaryKey(),                         // S3 返回的 opaque UploadId
    uploadFileId: uuid('upload_file_id').notNull().references(() => uploadFile.id),
    storageKey: text('storage_key').notNull(),
    partCount: integer('part_count').notNull(),
    state: text('state').notNull().default('pending'),
    resultSha256: text('result_sha256'),
    resultByteSize: bigint('result_byte_size', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    check('mu_part_count', sql`part_count >= 2 and part_count <= 10000`),
    check('mu_state', sql`state in ('pending', 'completed')`),
    index('idx_multipart_upload_file').on(t.uploadFileId),
  ],
);

/** 放弃上报的幂等台账(m1-99 A8):discard_event_id 由客户端持久化,重放只应产生一行 journal。
 *  这是 L2 结构 —— 删库重建后台账为空,重放窗口内可能补出第二行;
 *  journal 回放(D16,M3)落地后该台账可由 L1 自身重建,届时本表退化为缓存(D17)。 */
export const captureDiscardEvent = pgTable('capture_discard_event', {
  id: uuid('id').primaryKey(),                       // == discard_event_id
  personId: uuid('person_id').notNull().references(() => person.id),
  clientDocumentId: uuid('client_document_id').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});

/** M2 人工操作的 DB 幂等缓存。权威事实仍在 L1 journal/audit/correction；
 *  本表只防止弱网重试重复追加不可删除的事件。 */
export const humanOperation = pgTable('human_operation', {
  id: uuid('id').primaryKey(),                         // == client_operation_id
  kind: text('kind').notNull(),
  documentId: uuid('document_id').notNull().references(() => document.id),
  request: jsonb('request').notNull(),
  result: jsonb('result').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** P0-P4 通用人工操作幂等缓存。L1 fact 对应行可由 journal.operation_replay 重建。 */
export const operationLedger = pgTable(
  'operation_ledger',
  {
    accountId: uuid('account_id').notNull().references(() => account.id),
    clientOperationId: uuid('client_operation_id').notNull(),
    kind: text('kind').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id'),
    personId: uuid('person_id').references(() => person.id),
    requestHash: text('request_hash').notNull(),
    request: jsonb('request').notNull(),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.clientOperationId] }),
    index('idx_operation_ledger_subject').on(t.subjectType, t.subjectId),
    index('idx_operation_ledger_person').on(t.personId, t.createdAt.desc()),
  ],
);

// ── M2:后台任务队列(spec m2-04 §2)。属 L2 —— 删库重建后为空,
//    禁止因缺少 job 记录而使任何 L1 数据不可用。
export const aiJob = pgTable(
  'ai_job',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    documentId: uuid('document_id').references(() => document.id),
    /** 可空:facility_normalize 是**家庭级**作业,不属于任何一个 person(审核 #004 A-7) */
    personId: uuid('person_id').references(() => person.id),
    state: text('state').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: jsonb('last_error'),
    resultKey: text('result_key'),
    /** 去重键。构造规则的单一出处是 contracts 的 dedupKey ——
     *  散落在调用点会导致某一处静默写错,而写错的表现是"作业莫名其妙只出现过一次"。 */
    dedupKey: text('dedup_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('aj_kind', inList('kind', AiJobKind.options)),
    check('aj_state', inList('state', AiJobState.options)),
    check('aj_person', sql`kind <> 'stage1' or person_id is not null`),
    uniqueIndex('uq_ai_job_dedup').on(t.dedupKey),
    index('idx_ai_job_ready').on(t.state, t.nextAttemptAt),
  ],
);

// ── M2:归一化决策(spec m2-05 §2,ADR-040)。
//    confirmed 行属 L1 人工层(可从 _index/decisions/ 回放);proposed 行属 L2。
export const normalizationDecision = pgTable(
  'normalization_decision',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    /** 同输入指纹 → 同决策,确定性重放(ADR-040) */
    inputFingerprint: text('input_fingerprint').notNull(),
    proposal: jsonb('proposal').notNull(),
    state: text('state').notNull().default('proposed'),
    decidedBy: uuid('decided_by').references(() => account.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    clientOperationId: uuid('client_operation_id'),
    promptId: text('prompt_id'),
    promptVersion: integer('prompt_version'),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('nd_kind', inList('kind', NormalizationKind.options)),
    check('nd_state', inList('state', NormalizationState.options)),
    uniqueIndex('uq_normalization_fingerprint').on(t.inputFingerprint),
    uniqueIndex('uq_normalization_client_operation').on(t.clientOperationId),
  ],
);

// ── P0-P4:provider-neutral 可选处理层。全部属于可清空的 L2。──
export const processingPlugin = pgTable(
  'processing_plugin',
  {
    pluginId: text('plugin_id').primaryKey(),
    pluginVersion: text('plugin_version').notNull(),
    capabilities: text('capabilities').array().notNull(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }).notNull(),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    index('idx_processing_plugin_heartbeat').on(t.lastHeartbeatAt),
  ],
);

export const processingJob = pgTable(
  'processing_job',
  {
    id: uuid('id').primaryKey(),
    capability: text('capability').notNull(),
    targetPluginId: text('target_plugin_id').notNull(),
    targetPluginVersion: text('target_plugin_version').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    personId: uuid('person_id').references(() => person.id),
    inputRevision: integer('input_revision').notNull().default(0),
    inputSha256: text('input_sha256').notNull(),
    runGeneration: integer('run_generation').notNull().default(0),
    dedupKey: text('dedup_key').notNull(),
    state: text('state').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    resultKey: text('result_key'),
    resultSha256: text('result_sha256'),
    lastError: jsonb('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('pj_capability', inList('capability', ProcessingCapability.options)),
    check('pj_subject_type', inList('subject_type', ProcessingSubjectType.options)),
    check('pj_state', inList('state', ProcessingJobState.options)),
    check('pj_attempts', sql`attempt >= 0 and max_attempts >= 1`),
    check('pj_generation', sql`input_revision >= 0 and run_generation >= 0`),
    check('pj_person_scope', sql`(subject_type = 'family' and person_id is null) or (subject_type <> 'family' and person_id is not null)`),
    uniqueIndex('uq_processing_job_dedup').on(t.dedupKey),
    index('idx_processing_job_ready').on(t.state, t.nextAttemptAt, t.id),
    index('idx_processing_job_target').on(t.targetPluginId, t.targetPluginVersion, t.state),
    index('idx_processing_job_person').on(t.personId, t.updatedAt.desc(), t.id.desc()),
  ],
);

export const processingSuggestion = pgTable(
  'processing_suggestion',
  {
    id: uuid('id').primaryKey(),
    capability: text('capability').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    personId: uuid('person_id').references(() => person.id),
    inputRevision: integer('input_revision').notNull(),
    inputSha256: text('input_sha256').notNull(),
    payload: jsonb('payload').notNull(),
    pluginId: text('plugin_id').notNull(),
    pluginVersion: text('plugin_version').notNull(),
    provider: text('provider'),
    model: text('model'),
    promptId: text('prompt_id'),
    promptVersion: text('prompt_version'),
    artifactKey: text('artifact_key'),
    artifactSha256: text('artifact_sha256'),
    state: text('state').notNull().default('proposed'),
    acceptedFields: text('accepted_fields').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ps_capability', inList('capability', ProcessingCapability.options)),
    check('ps_subject_type', inList('subject_type', ProcessingSubjectType.options)),
    check('ps_state', inList('state', ProcessingSuggestionState.options)),
    check('ps_revision', sql`input_revision >= 0`),
    check('ps_person_scope', sql`(subject_type = 'family' and person_id is null) or (subject_type <> 'family' and person_id is not null)`),
    uniqueIndex('uq_processing_suggestion_input').on(
      t.capability, t.subjectType, t.subjectId, t.pluginId, t.pluginVersion, t.inputSha256,
    ),
    index('idx_processing_suggestion_person').on(t.personId, t.state, t.createdAt.desc()),
  ],
);

/** P0-P4 可重建关键词投影；assist corpus 与 core corpus 物理分列。 */
export const searchEntry = pgTable(
  'search_entry',
  {
    id: uuid('id').primaryKey(),
    personId: uuid('person_id').notNull().references(() => person.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    documentId: uuid('document_id').references(() => document.id),
    occurredOn: date('occurred_on'),
    sortAt: timestamp('sort_at', { withTimezone: true }),
    title: text('title').notNull(),
    coreBody: text('core_body').notNull().default(''),
    assistBody: text('assist_body'),
    sourceRevisionHash: text('source_revision_hash').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('search_entity_type', inList('entity_type', SearchEntityType.options)),
    uniqueIndex('uq_search_entry_entity').on(t.entityType, t.entityId),
    index('idx_search_entry_person_sort').on(t.personId, t.sortAt.desc(), t.id.desc()),
    index('idx_search_entry_person_type_sort').on(t.personId, t.entityType, t.sortAt.desc(), t.id.desc()),
    index('idx_search_entry_title_trgm').using('gin', sql`${t.title} gin_trgm_ops`),
    index('idx_search_entry_core_trgm').using('gin', sql`${t.coreBody} gin_trgm_ops`),
  ],
);

// ── P1：离线情境与安全媒体的 L1 投影。──
export const contextSession = pgTable(
  'context_session',
  {
    id: uuid('id').primaryKey(),
    personId: uuid('person_id').notNull().references(() => person.id),
    scopeType: text('scope_type').notNull(),
    scopeKey: text('scope_key').notNull(),
    clientDocumentId: text('client_document_id'),
    documentId: uuid('document_id').references(() => document.id),
    encounterId: uuid('encounter_id').references(() => encounter.id),
    templateId: text('template_id').notNull(),
    templateVersion: integer('template_version').notNull(),
    templateHash: text('template_hash').notNull(),
    questionSnapshot: jsonb('question_snapshot').notNull(),
    stage: text('stage').notNull(),
    status: text('status').notNull().default('active'),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').notNull().references(() => account.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull().references(() => account.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    check('cs_scope_type', inList('scope_type', ContextScopeType.options)),
    check('cs_stage', inList('stage', ContextStage.options)),
    check('cs_status', inList('status', ContextSessionStatus.options)),
    check('cs_revision', sql`revision >= 1`),
    check('cs_scope_key_length', sql`char_length(scope_key) between 8 and 64`),
    check('cs_template_hash', sql`template_hash ~ '^[0-9a-f]{64}$'`),
    check('cs_scope_document', sql`(
      scope_type = 'document' and client_document_id is not null and scope_key = client_document_id
    ) or (scope_type = 'standalone' and client_document_id is null)`),
    uniqueIndex('uq_context_session_scope').on(
      t.personId, t.scopeType, t.scopeKey, t.templateId, t.templateVersion, t.stage,
    ),
    index('idx_context_session_pending').on(t.personId, t.status, t.createdAt.desc(), t.id.desc()),
    index('idx_context_session_document').on(t.documentId),
  ],
);

export const contextUpload = pgTable(
  'context_upload',
  {
    id: uuid('id').primaryKey(),
    personId: uuid('person_id').notNull().references(() => person.id),
    sessionId: uuid('session_id').notNull().references(() => contextSession.id),
    questionKey: text('question_key').notNull(),
    kind: text('kind').notNull(),
    mime: text('mime').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    objectKey: text('object_key').notNull().unique(),
    state: text('state').notNull().default('prepared'),
    multipartState: jsonb('multipart_state'),
    createdBy: uuid('created_by').notNull().references(() => account.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (t) => [
    check('cu_kind', inList('kind', ContextMediaKind.options)),
    check('cu_mime', inList('mime', ContextMediaMime.options)),
    check('cu_state', inList('state', ContextUploadState.options)),
    check('cu_byte_size', sql`byte_size > 0`),
    check('cu_sha256', sql`sha256 ~ '^[0-9a-f]{64}$'`),
    index('idx_context_upload_session').on(t.sessionId, t.questionKey),
  ],
);

export const contextAnswer = pgTable(
  'context_answer',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id').notNull().references(() => contextSession.id),
    questionKey: text('question_key').notNull(),
    questionText: text('question_text').notNull(),
    questionSnapshot: jsonb('question_snapshot').notNull(),
    answerType: text('answer_type').notNull(),
    value: jsonb('value'),
    uploadId: uuid('upload_id').references(() => contextUpload.id),
    skipped: boolean('skipped').notNull().default(false),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    eventOn: date('event_on'),
    eventAt: timestamp('event_at', { withTimezone: true }),
    timePrecision: text('time_precision'),
    eventTimeSource: text('event_time_source'),
    revision: integer('revision').notNull().default(1),
    updatedBy: uuid('updated_by').notNull().references(() => account.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ca_answer_type', inList('answer_type', ContextAnswerType.options)),
    check('ca_time_precision', sql`time_precision is null or time_precision in ('date', 'minute', 'unknown')`),
    check('ca_event_time_source', sql`event_time_source is null or ${inList('event_time_source', ContextEventTimeSource.options)}`),
    check('ca_revision', sql`revision >= 1`),
    check('ca_value', sql`(skipped and value is null and upload_id is null) or not skipped`),
    uniqueIndex('uq_context_answer_question').on(t.sessionId, t.questionKey),
    index('idx_context_answer_upload').on(t.uploadId),
  ],
);

// ── P2：人工 observation、显式概念映射与稳定来源。──
export const conceptAliasDecision = pgTable(
  'concept_alias_decision',
  {
    id: uuid('id').primaryKey(),
    personId: uuid('person_id').notNull().references(() => person.id),
    inputFingerprint: text('input_fingerprint').notNull(),
    localName: text('local_name').notNull(),
    context: jsonb('context').notNull().default(sql`'{"specimen":null,"method":null}'::jsonb`),
    conceptCode: text('concept_code').notNull(),
    displayName: text('display_name').notNull(),
    catalogVersion: text('catalog_version').notNull(),
    state: text('state').notNull().default('confirmed'),
    revision: integer('revision').notNull().default(1),
    decidedBy: uuid('decided_by').notNull().references(() => account.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('cad_fingerprint', sql`input_fingerprint ~ '^[0-9a-f]{64}$'`),
    check('cad_state', sql`state in ('confirmed', 'superseded')`),
    check('cad_revision', sql`revision >= 1`),
    uniqueIndex('uq_concept_alias_active').on(t.personId, t.inputFingerprint)
      .where(sql`${t.state} = 'confirmed'`),
    index('idx_concept_alias_person').on(t.personId, t.localName, t.id),
  ],
);

export const observation = pgTable(
  'observation',
  {
    id: uuid('id').primaryKey(),
    personId: uuid('person_id').notNull().references(() => person.id),
    documentId: uuid('document_id').references(() => document.id),
    encounterId: uuid('encounter_id').references(() => encounter.id),
    clientRowId: uuid('client_row_id'),

    observedOn: date('observed_on').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    timePrecision: text('time_precision').notNull(),
    dateSource: text('date_source').notNull(),

    localName: text('local_name').notNull(),
    mappingFingerprint: text('mapping_fingerprint').notNull(),
    conceptCode: text('concept_code'),
    conceptCatalogVersion: text('concept_catalog_version'),
    loincCode: text('loinc_code'),
    qualifier: text('qualifier'),
    bodySite: text('body_site'),
    extraDims: jsonb('extra_dims'),
    seriesKey: text('series_key'),

    valueRaw: text('value_raw').notNull(),
    valueNum: numeric('value_num', { precision: 30, scale: 12, mode: 'number' }),
    comparator: text('comparator'),
    valueText: text('value_text'),
    valueDimensions: jsonb('value_dimensions'),
    unitRaw: text('unit_raw'),
    unitUcum: text('unit_ucum'),
    valueSi: numeric('value_si', { precision: 30, scale: 12, mode: 'number' }),
    unitSi: text('unit_si'),
    conversionVersion: text('conversion_version'),

    refLow: numeric('ref_low', { precision: 30, scale: 12, mode: 'number' }),
    refHigh: numeric('ref_high', { precision: 30, scale: 12, mode: 'number' }),
    refText: text('ref_text'),
    refUnit: text('ref_unit'),
    abnormalFlagRaw: text('abnormal_flag_raw'),
    abnormalFlag: text('abnormal_flag'),

    specimen: text('specimen'),
    specimenLabel: text('specimen_label'),
    method: text('method'),
    device: text('device'),
    measurementSetting: text('measurement_setting'),
    resultKind: text('result_kind').notNull().default('measured'),
    collectedAt: timestamp('collected_at', { withTimezone: true }),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    labFacilityId: uuid('lab_facility_id').references(() => facility.id),

    originCaptureDocumentId: uuid('origin_capture_document_id'),
    originCaptureOrder: integer('origin_capture_order'),
    objectSha256: text('object_sha256'),
    logicalPageIndex: integer('logical_page_index'),
    sourceBbox: jsonb('source_bbox'),
    currentDocumentId: uuid('current_document_id').references(() => document.id),
    currentPageNo: integer('current_page_no'),

    source: text('source').notNull(),
    sourceRef: jsonb('source_ref'),
    reviewStatus: text('review_status').notNull(),
    reviewedBy: uuid('reviewed_by').references(() => account.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    consistencyFlags: text('consistency_flags').array().notNull().default(sql`'{}'::text[]`),

    isDerived: boolean('is_derived').notNull().default(false),
    derivedFormula: text('derived_formula'),
    calculationVersion: text('calculation_version'),
    derivationKey: text('derivation_key'),
    inputObservationIds: uuid('input_observation_ids').array(),
    inputRevisionHash: text('input_revision_hash'),

    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').references(() => account.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => account.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    check('obs_time_precision', inList('time_precision', ObservationTimePrecision.options)),
    check('obs_date_source', inList('date_source', ObservationDateSource.options)),
    check('obs_time_consistency', sql`(
      time_precision = 'minute' and observed_at is not null
    ) or (time_precision <> 'minute' and observed_at is null)`),
    check('obs_comparator', sql`comparator is null or ${inList('comparator', ObservationComparator.options)}`),
    check('obs_result_kind', inList('result_kind', ObservationResultKind.options)),
    check('obs_source', inList('source', ObservationSource.options)),
    check('obs_review_status', inList('review_status', ObservationReviewStatus.options)),
    check('obs_abnormal_flag', sql`abnormal_flag is null or ${inList('abnormal_flag', ObservationAbnormalFlag.options)}`),
    check('obs_revision', sql`revision >= 1`),
    check('obs_mapping_fingerprint', sql`mapping_fingerprint ~ '^[0-9a-f]{64}$'`),
    check('obs_value_present', sql`value_num is not null or value_text is not null or value_dimensions is not null`),
    check('obs_comparator_numeric', sql`comparator is null or value_num is not null`),
    check('obs_concept_series', sql`(
      concept_code is null and concept_catalog_version is null and loinc_code is null and series_key is null
    ) or (concept_code is not null and concept_catalog_version is not null and series_key is not null)`),
    check('obs_series_key', sql`series_key is null or series_key ~ '^[0-9a-f]{64}$'`),
    check('obs_conversion_complete', sql`(
      value_si is null and unit_si is null and conversion_version is null
    ) or (value_si is not null and unit_si is not null and conversion_version is not null)`),
    check('obs_origin_complete', sql`(
      origin_capture_document_id is null and origin_capture_order is null
      and object_sha256 is null and logical_page_index is null and source_bbox is null
      and current_document_id is null and current_page_no is null
    ) or (
      origin_capture_document_id is not null and origin_capture_order >= 1
      and object_sha256 ~ '^[0-9a-f]{64}$' and logical_page_index >= 1
    )`),
    check('obs_current_page', sql`current_page_no is null or current_page_no >= 1`),
    check('obs_derived_fields', sql`(
      not is_derived
    ) or (
      source = 'derived' and derived_formula is not null and calculation_version is not null
      and derivation_key ~ '^[0-9a-f]{64}$' and input_observation_ids is not null
      and cardinality(input_observation_ids) > 0 and input_revision_hash ~ '^[0-9a-f]{64}$'
    )`),
    uniqueIndex('uq_observation_client_row').on(t.personId, t.clientRowId)
      .where(sql`${t.clientRowId} is not null`),
    index('idx_observation_person_concept_time')
      .on(t.personId, t.conceptCode, t.observedOn.desc(), t.observedAt.desc(), t.id.desc()),
    index('idx_observation_person_review').on(t.personId, t.archivedAt, t.reviewStatus, t.id),
    index('idx_observation_series_time')
      .on(t.personId, t.conceptCode, t.seriesKey, t.observedOn.desc(), t.id.desc()),
    index('idx_observation_origin').on(
      t.originCaptureDocumentId, t.originCaptureOrder, t.logicalPageIndex,
    ),
    index('idx_observation_mapping_inbox').on(t.personId, t.mappingFingerprint, t.id)
      .where(sql`${t.conceptCode} is null and ${t.archivedAt} is null`),
  ],
);

// ── P3：用户拥有的监控组。趋势本身是可重建投影，不落在此 L1 schema。──
export const metricGroup = pgTable(
  'metric_group',
  {
    id: uuid('id').primaryKey(),
    personId: uuid('person_id').notNull().references(() => person.id),
    name: text('name').notNull(),
    description: text('description'),
    presetOrigin: text('preset_origin'),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').notNull().references(() => account.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull().references(() => account.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    check('metric_group_preset_origin', sql`preset_origin is null or ${inList('preset_origin', MetricGroupPreset.options)}`),
    check('metric_group_revision', sql`revision >= 1`),
    index('idx_metric_group_person_updated')
      .on(t.personId, t.archivedAt, t.updatedAt.desc(), t.id.desc()),
  ],
);

export const metricGroupItem = pgTable(
  'metric_group_item',
  {
    id: uuid('id').primaryKey(),
    metricGroupId: uuid('metric_group_id').notNull()
      .references(() => metricGroup.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    itemType: text('item_type').notNull().default('series'),
    conceptCode: text('concept_code').notNull(),
    qualifier: text('qualifier'),
    bodySite: text('body_site'),
    specimen: text('specimen'),
    method: text('method'),
    device: text('device'),
    measurementSetting: text('measurement_setting'),
    extraDims: jsonb('extra_dims'),
    resultKind: text('result_kind').notNull(),
    seriesSelectorHash: text('series_selector_hash').notNull(),
  },
  (t) => [
    check('metric_group_item_position', sql`position >= 0`),
    check('metric_group_item_type', sql`item_type = 'series'`),
    check('metric_group_item_result_kind', inList('result_kind', ObservationResultKind.options)),
    check('metric_group_item_selector_hash', sql`series_selector_hash ~ '^[0-9a-f]{64}$'`),
    uniqueIndex('uq_metric_group_item_position').on(t.metricGroupId, t.position),
    uniqueIndex('uq_metric_group_item_selector').on(t.metricGroupId, t.seriesSelectorHash),
  ],
);

// ── P4：人工用药与中性时间轴事实。两者与 observation 使用相同的稳定来源身份。──
export const medication = pgTable(
  'medication',
  {
    id: uuid('id').primaryKey(),
    personId: uuid('person_id').notNull().references(() => person.id),
    encounterId: uuid('encounter_id').references(() => encounter.id),
    clientRowId: uuid('client_row_id').notNull(),
    kind: text('kind').notNull(),
    nameRaw: text('name_raw').notNull(),
    genericName: text('generic_name'),
    doseRaw: text('dose_raw'),
    doseValue: numeric('dose_value', { precision: 30, scale: 12, mode: 'number' }),
    doseUnit: text('dose_unit'),
    concentrationPct: numeric('concentration_pct', { precision: 12, scale: 6, mode: 'number' }),
    soluteMassG: numeric('solute_mass_g', { precision: 30, scale: 12, mode: 'number' }),
    frequencyRaw: text('frequency_raw'),
    route: text('route'),
    administrationGroup: text('administration_group'),
    groupVolumeMl: numeric('group_volume_ml', { precision: 30, scale: 12, mode: 'number' }),
    sequence: integer('sequence'),
    administeredAt: timestamp('administered_at', { withTimezone: true }),
    startedOn: date('started_on'),
    endedOn: date('ended_on'),
    originCaptureDocumentId: uuid('origin_capture_document_id'),
    originCaptureOrder: integer('origin_capture_order'),
    objectSha256: text('object_sha256'),
    logicalPageIndex: integer('logical_page_index'),
    sourceBbox: jsonb('source_bbox'),
    currentDocumentId: uuid('current_document_id').references(() => document.id),
    currentPageNo: integer('current_page_no'),
    note: text('note'),
    source: text('source').notNull().default('manual'),
    sourceRef: jsonb('source_ref'),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').notNull().references(() => account.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull().references(() => account.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    check('medication_kind', inList('kind', MedicationKind.options)),
    check('medication_source', inList('source', MedicationSource.options)),
    check('medication_revision', sql`revision >= 1`),
    check('medication_required_time', sql`(
      kind = 'administered' and administered_at is not null
    ) or (kind = 'prescribed' and started_on is not null)`),
    check('medication_date_order', sql`ended_on is null or started_on is null or ended_on >= started_on`),
    check('medication_dose_complete', sql`(dose_value is null) = (dose_unit is null)`),
    check('medication_nonnegative', sql`(
      dose_value is null or dose_value >= 0
    ) and (concentration_pct is null or concentration_pct between 0 and 100)
      and (solute_mass_g is null or solute_mass_g >= 0)
      and (group_volume_ml is null or group_volume_ml >= 0)`),
    check('medication_sequence_group', sql`sequence is null or (sequence >= 1 and administration_group is not null)`),
    check('medication_origin_complete', sql`(
      origin_capture_document_id is null and origin_capture_order is null
      and object_sha256 is null and logical_page_index is null and source_bbox is null
      and current_document_id is null and current_page_no is null
    ) or (
      origin_capture_document_id is not null and origin_capture_order >= 1
      and object_sha256 ~ '^[0-9a-f]{64}$' and logical_page_index >= 1
    )`),
    check('medication_current_page', sql`current_page_no is null or current_page_no >= 1`),
    uniqueIndex('uq_medication_client_row').on(t.personId, t.clientRowId),
    index('idx_medication_person_canonical').on(
      t.personId,
      sql`COALESCE((${t.administeredAt} at time zone 'UTC')::date, ${t.startedOn}) desc`,
      t.administeredAt.desc(), t.id.desc(),
    ),
    index('idx_medication_origin').on(
      t.originCaptureDocumentId, t.originCaptureOrder, t.logicalPageIndex,
    ),
  ],
);

export const timelineEvent = pgTable(
  'timeline_event',
  {
    id: uuid('id').primaryKey(),
    personId: uuid('person_id').notNull().references(() => person.id),
    encounterId: uuid('encounter_id').references(() => encounter.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    occurredOn: date('occurred_on'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    timePrecision: text('time_precision').notNull(),
    note: text('note'),
    originCaptureDocumentId: uuid('origin_capture_document_id'),
    originCaptureOrder: integer('origin_capture_order'),
    objectSha256: text('object_sha256'),
    logicalPageIndex: integer('logical_page_index'),
    sourceBbox: jsonb('source_bbox'),
    currentDocumentId: uuid('current_document_id').references(() => document.id),
    currentPageNo: integer('current_page_no'),
    source: text('source').notNull().default('manual'),
    sourceRef: jsonb('source_ref'),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').notNull().references(() => account.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull().references(() => account.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    check('timeline_event_kind', inList('kind', TimelineEventKind.options)),
    check('timeline_event_precision', inList('time_precision', ClinicalTimePrecision.options)),
    check('timeline_event_source', inList('source', MedicationSource.options)),
    check('timeline_event_revision', sql`revision >= 1`),
    check('timeline_event_time', sql`(
      time_precision = 'minute' and occurred_on is not null and occurred_at is not null
    ) or (
      time_precision = 'date' and occurred_on is not null and occurred_at is null
    ) or (
      time_precision = 'unknown' and occurred_on is null and occurred_at is null
    )`),
    check('timeline_event_origin_complete', sql`(
      origin_capture_document_id is null and origin_capture_order is null
      and object_sha256 is null and logical_page_index is null and source_bbox is null
      and current_document_id is null and current_page_no is null
    ) or (
      origin_capture_document_id is not null and origin_capture_order >= 1
      and object_sha256 ~ '^[0-9a-f]{64}$' and logical_page_index >= 1
    )`),
    check('timeline_event_current_page', sql`current_page_no is null or current_page_no >= 1`),
    index('idx_timeline_event_person_time')
      .on(t.personId, t.occurredOn.desc(), t.occurredAt.desc(), t.id.desc()),
    index('idx_timeline_event_origin').on(
      t.originCaptureDocumentId, t.originCaptureOrder, t.logicalPageIndex,
    ),
  ],
);

// ── P4：可删除、可重新生成的确定性导出与公开分享安全状态。──
export const exportJob = pgTable(
  'export_job',
  {
    id: uuid('id').primaryKey(),
    personId: uuid('person_id').notNull().references(() => person.id),
    kind: text('kind').notNull().default('visit_summary'),
    clientOperationId: uuid('client_operation_id').notNull(),
    request: jsonb('request').notNull(),
    requestHash: text('request_hash').notNull(),
    sourceRevisionHash: text('source_revision_hash').notNull(),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }).notNull(),
    inputManifest: jsonb('input_manifest').notNull(),
    state: text('state').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    progress: integer('progress').notNull().default(0),
    lastError: jsonb('last_error'),
    rendererId: text('renderer_id').notNull(),
    rendererVersion: text('renderer_version').notNull(),
    fontManifestHash: text('font_manifest_hash').notNull(),
    resultKey: text('result_key'),
    resultSha256: text('result_sha256'),
    resultByteSize: bigint('result_byte_size', { mode: 'number' }),
    resultContentHash: text('result_content_hash'),
    createdBy: uuid('created_by').notNull().references(() => account.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    check('export_job_kind', sql`kind = 'visit_summary'`),
    check('export_job_state', sql`state in ('pending','running','done','failed')`),
    check('export_job_attempts', sql`attempt >= 0 and max_attempts >= 1`),
    check('export_job_progress', sql`progress between 0 and 100`),
    check('export_job_hashes', sql`
      request_hash ~ '^[0-9a-f]{64}$'
      and source_revision_hash ~ '^[0-9a-f]{64}$'
      and font_manifest_hash ~ '^[0-9a-f]{64}$'
      and (result_sha256 is null or result_sha256 ~ '^[0-9a-f]{64}$')
      and (result_content_hash is null or result_content_hash ~ '^[0-9a-f]{64}$')
    `),
    check('export_job_result', sql`(
      state <> 'done'
    ) or (
      result_key is not null and result_sha256 is not null
      and result_byte_size is not null and result_content_hash is not null
    )`),
    uniqueIndex('uq_export_job_operation').on(t.createdBy, t.clientOperationId),
    index('idx_export_job_ready').on(t.state, t.nextAttemptAt, t.id),
    index('idx_export_job_person').on(t.personId, t.createdAt.desc(), t.id.desc()),
  ],
);

export const exportShare = pgTable(
  'export_share',
  {
    id: uuid('id').primaryKey(),
    exportJobId: uuid('export_job_id').notNull().references(() => exportJob.id),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: uuid('created_by').notNull().references(() => account.id),
    clientOperationId: uuid('client_operation_id').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    accessCount: integer('access_count').notNull().default(0),
  },
  (t) => [
    check('export_share_token_hash', sql`token_hash ~ '^[0-9a-f]{64}$'`),
    check('export_share_request_hash', sql`request_hash ~ '^[0-9a-f]{64}$'`),
    check('export_share_access_count', sql`access_count >= 0`),
    uniqueIndex('uq_export_share_token').on(t.tokenHash),
    uniqueIndex('uq_export_share_operation').on(t.createdBy, t.clientOperationId),
    index('idx_export_share_job').on(t.exportJobId, t.createdAt.desc(), t.id.desc()),
    index('idx_export_share_expiry').on(t.expiresAt),
  ],
);
