// spec m0-99 A10:穷尽字段比对。--dump snapshot.json(删库前)/ --compare snapshot.json(重建后)。
// 排除:account、person_access(显式边界,审核 #001 #6)。
import { writeFileSync, readFileSync } from 'node:fs';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL ?? 'postgres://amr:amr@localhost:5433/amr', {
  max: 1, onnotice: () => {},
});

// 穷尽字段表(spec m0-99 A10)
async function snapshot() {
  const people = await sql`
    select id, slug, display_name, name_pinyin, birth_date::text, sex_at_birth, gender,
           relation_to_owner, blood_type, allergies, chronic_conditions, note,
           archived_at is not null as archived
    from person order by slug`;
  const identifiers = await sql`
    select id, person_id, facility_id, identifier_type, identifier_value, scope
    from person_identifier order by id`;
  const documents = await sql`
    select id, short_id, person_id, capture_date::text, captured_at, source,
           original_filename, status, client_document_id, encounter_id,
           archived_at, person_check_ack_at
    from document order by short_id`;
  // M2 只自动产生建议；每一行 encounter 都来自人工确认，因此 id 的存在与
  // grouping_basis 都属于不可重算事实。其他列没有在 m2-01 §5 标为 L1。
  const encounters = await sql`
    select id, person_id, encounter_type, facility_id, department, occurred_on::text,
           ended_on::text, occurred_at, chief_complaint, diagnosis_text, doctor_advice,
           grouping_basis, revision, updated_by, updated_at, archived_at
    from encounter order by id`;
  const documentMetadata = await sql`
    select document_id, doc_type, sampled_on::text, reported_on::text, facility_id,
           facility_name_raw, department, title, note, field_provenance, revision,
           updated_by, updated_at
    from document_manual_metadata order by document_id`;
  const contextSessions = await sql`
    select id, person_id, scope_type, scope_key, client_document_id, document_id, encounter_id,
           template_id, template_version, template_hash, question_snapshot, stage, status,
           revision, created_by, created_at, updated_by, updated_at, completed_at
    from context_session order by id`;
  const contextAnswers = await sql`
    select id, session_id, question_key, question_text, question_snapshot, answer_type, value,
           upload_id, skipped, answered_at, event_on::text, event_at, time_precision,
           event_time_source, revision, updated_by, updated_at
    from context_answer order by session_id, question_key`;
  const contextUploads = await sql`
    select id, person_id, session_id, question_key, kind, mime, byte_size, sha256,
           object_key, state, multipart_state, created_by, created_at, finalized_at
    from context_upload order by id`;
  const conceptAliases = await sql`
    select id, person_id, input_fingerprint, local_name, context, concept_code, display_name,
           catalog_version, state, revision, decided_by, decided_at, updated_at
    from concept_alias_decision order by id`;
  // derived observation 是可删除 L2，不与 L1 快照混在一起。P2-9 由独立的
  // dependency replay 验收证明重算结果；这里穷尽比对人工/导入/已接受事实。
  const observations = await sql`
    select id, person_id, document_id, encounter_id, client_row_id,
           observed_on::text, observed_at, time_precision, date_source,
           local_name, mapping_fingerprint, concept_code, concept_catalog_version, loinc_code,
           qualifier, body_site, extra_dims, series_key,
           value_raw, value_num, comparator, value_text, value_dimensions,
           unit_raw, unit_ucum, value_si, unit_si, conversion_version,
           ref_low, ref_high, ref_text, ref_unit, abnormal_flag_raw, abnormal_flag,
           specimen, specimen_label, method, device, measurement_setting, result_kind,
           collected_at, reported_at, lab_facility_id,
           origin_capture_document_id, origin_capture_order, object_sha256,
           logical_page_index, source_bbox, current_document_id, current_page_no,
           source, source_ref, review_status, reviewed_by, reviewed_at, consistency_flags,
           is_derived, derived_formula, calculation_version, derivation_key,
           input_observation_ids, input_revision_hash,
           revision, created_by, created_at, updated_by, updated_at, archived_at
    from observation where is_derived = false order by id`;
  // P2-9：derived 是可删除 L2，因此不要求恢复其运行时时间戳；但由 L1 输入
  // 决定的身份、数值、series、公式及 dependency fingerprint 必须逐字段等价。
  const derivedObservations = await sql`
    select id, person_id, document_id, encounter_id,
           observed_on::text, observed_at, time_precision, date_source,
           local_name, mapping_fingerprint, concept_code, concept_catalog_version, loinc_code,
           qualifier, body_site, extra_dims, series_key,
           value_raw, value_num, comparator, value_text, value_dimensions,
           unit_raw, unit_ucum, value_si, unit_si, conversion_version,
           ref_low, ref_high, ref_text, ref_unit, abnormal_flag_raw, abnormal_flag,
           specimen, specimen_label, method, device, measurement_setting, result_kind,
           collected_at, reported_at, lab_facility_id,
           origin_capture_document_id, origin_capture_order, object_sha256,
           logical_page_index, source_bbox, current_document_id, current_page_no,
           source, source_ref, review_status, consistency_flags,
           is_derived, derived_formula, calculation_version, derivation_key,
           input_observation_ids, input_revision_hash, revision, archived_at
    from observation where is_derived = true order by id`;
  const metricGroups = await sql`
    select id, person_id, name, description, preset_origin, revision, created_by, created_at,
           updated_by, updated_at, archived_at
    from metric_group order by id`;
  const metricGroupItems = await sql`
    select id, metric_group_id, position, item_type, concept_code, qualifier, body_site,
           specimen, method, device, measurement_setting, extra_dims, result_kind,
           series_selector_hash
    from metric_group_item order by metric_group_id, position, id`;
  const medications = await sql`
    select id, person_id, encounter_id, client_row_id, kind, name_raw, generic_name, dose_raw,
           dose_value, dose_unit, concentration_pct, solute_mass_g, frequency_raw, route,
           administration_group, group_volume_ml, sequence, administered_at, started_on::text,
           ended_on::text, origin_capture_document_id, origin_capture_order, object_sha256,
           logical_page_index, source_bbox, current_document_id, current_page_no, note, source,
           source_ref, revision, created_by, created_at, updated_by, updated_at, archived_at
    from medication order by id`;
  const timelineEvents = await sql`
    select id, person_id, encounter_id, kind, title, occurred_on::text, occurred_at,
           time_precision, note, origin_capture_document_id, origin_capture_order, object_sha256,
           logical_page_index, source_bbox, current_document_id, current_page_no, source,
           source_ref, revision, created_by, created_at, updated_by, updated_at, archived_at
    from timeline_event order by id`;
  const operationLedger = await sql`
    select account_id, client_operation_id, kind, subject_type, subject_id, person_id,
           request_hash, result
    from operation_ledger
    where kind in (
      'document_metadata_upsert', 'encounter_upsert', 'encounter_documents_set',
      'context_session_upsert', 'context_answer_upsert', 'context_media_finalize',
      'observation_upsert', 'concept_alias_upsert',
      'metric_group_upsert', 'metric_group_archive',
      'medication_upsert', 'timeline_event_upsert'
    )
    order by account_id, client_operation_id`;
  // facility 表里 proposed-only 的行可由 L2 重算。这里只对账至少被一条
  // confirmed decision 引用的家庭词表项。
  const facilities = await sql`
    select f.slug, f.name, f.aliases, f.city, f.level
    from facility f
    where exists (
      select 1 from normalization_decision nd
      where nd.kind = 'facility' and nd.state = 'confirmed'
        and nd.proposal -> 'facility' ->> 'slug' = f.slug
    )
    order by f.slug`;
  const decisions = await sql`
    select kind, input_fingerprint, proposal, state, decided_by, decided_at, client_operation_id
    from normalization_decision where state <> 'proposed'
    order by input_fingerprint`;
  // thumb_key 不在字段表(m1-99 A19):它是 L2 派生物的位置,M1 根本不写它,
  // 比对一个恒为 null 的列只会制造"看起来通过了"的噪声。
  const pages = await sql`
    select document_id, page_no, storage_key, content_sha256, byte_size, mime_type,
           width, height, page_label, capture_order, origin_capture_document_id,
           origin_capture_order, origin_object_sha256
    from document_page order by storage_key`;
  return {
    people: people.map((r) => ({ ...r })),
    identifiers: identifiers.map((r) => ({ ...r })),
    documents: documents.map((r) => ({
      ...r,
      captured_at: (r['captured_at'] as Date).toISOString(),
      archived_at: r['archived_at'] instanceof Date ? r['archived_at'].toISOString() : null,
      person_check_ack_at: r['person_check_ack_at'] instanceof Date
        ? r['person_check_ack_at'].toISOString()
        : null,
    })),
    encounters: encounters.map((r) => ({
      ...r,
      occurred_at: r['occurred_at'] instanceof Date ? r['occurred_at'].toISOString() : null,
      updated_at: (r['updated_at'] as Date).toISOString(),
      archived_at: r['archived_at'] instanceof Date ? r['archived_at'].toISOString() : null,
    })),
    documentMetadata: documentMetadata.map((r) => ({
      ...r, updated_at: (r['updated_at'] as Date).toISOString(),
    })),
    contextSessions: contextSessions.map((r) => ({
      ...r,
      created_at: (r['created_at'] as Date).toISOString(),
      updated_at: (r['updated_at'] as Date).toISOString(),
      completed_at: r['completed_at'] instanceof Date ? r['completed_at'].toISOString() : null,
    })),
    contextAnswers: contextAnswers.map((r) => ({
      ...r,
      answered_at: r['answered_at'] instanceof Date ? r['answered_at'].toISOString() : null,
      event_at: r['event_at'] instanceof Date ? r['event_at'].toISOString() : null,
      updated_at: (r['updated_at'] as Date).toISOString(),
    })),
    contextUploads: contextUploads.map((r) => ({
      ...r,
      created_at: (r['created_at'] as Date).toISOString(),
      finalized_at: r['finalized_at'] instanceof Date ? r['finalized_at'].toISOString() : null,
    })),
    conceptAliases: conceptAliases.map((r) => ({
      ...r,
      decided_at: (r['decided_at'] as Date).toISOString(),
      updated_at: (r['updated_at'] as Date).toISOString(),
    })),
    observations: observations.map((r) => ({
      ...r,
      observed_at: r['observed_at'] instanceof Date ? r['observed_at'].toISOString() : null,
      collected_at: r['collected_at'] instanceof Date ? r['collected_at'].toISOString() : null,
      reported_at: r['reported_at'] instanceof Date ? r['reported_at'].toISOString() : null,
      reviewed_at: r['reviewed_at'] instanceof Date ? r['reviewed_at'].toISOString() : null,
      created_at: (r['created_at'] as Date).toISOString(),
      updated_at: (r['updated_at'] as Date).toISOString(),
      archived_at: r['archived_at'] instanceof Date ? r['archived_at'].toISOString() : null,
    })),
    derivedObservations: derivedObservations.map((r) => ({
      ...r,
      observed_at: r['observed_at'] instanceof Date ? r['observed_at'].toISOString() : null,
      collected_at: r['collected_at'] instanceof Date ? r['collected_at'].toISOString() : null,
      reported_at: r['reported_at'] instanceof Date ? r['reported_at'].toISOString() : null,
      archived_at: r['archived_at'] instanceof Date ? r['archived_at'].toISOString() : null,
    })),
    metricGroups: metricGroups.map((r) => ({
      ...r,
      created_at: (r['created_at'] as Date).toISOString(),
      updated_at: (r['updated_at'] as Date).toISOString(),
      archived_at: r['archived_at'] instanceof Date ? r['archived_at'].toISOString() : null,
    })),
    metricGroupItems: metricGroupItems.map((r) => ({ ...r })),
    medications: medications.map((r) => ({
      ...r,
      administered_at: r['administered_at'] instanceof Date ? r['administered_at'].toISOString() : null,
      created_at: (r['created_at'] as Date).toISOString(),
      updated_at: (r['updated_at'] as Date).toISOString(),
      archived_at: r['archived_at'] instanceof Date ? r['archived_at'].toISOString() : null,
    })),
    timelineEvents: timelineEvents.map((r) => ({
      ...r,
      occurred_at: r['occurred_at'] instanceof Date ? r['occurred_at'].toISOString() : null,
      created_at: (r['created_at'] as Date).toISOString(),
      updated_at: (r['updated_at'] as Date).toISOString(),
      archived_at: r['archived_at'] instanceof Date ? r['archived_at'].toISOString() : null,
    })),
    operationLedger: operationLedger.map((r) => ({ ...r })),
    facilities: facilities.map((r) => ({
      ...r,
      aliases: [...r['aliases'] as string[]].sort(),
    })),
    decisions: decisions.map((r) => ({
      ...r,
      decided_at: r['decided_at'] instanceof Date ? r['decided_at'].toISOString() : null,
    })),
    pages: pages.map((r) => ({ ...r })),
  };
}

const mode = process.argv[2];
const file = process.argv[3] ?? 'snapshot.json';
const snap = await snapshot();

if (mode === '--dump') {
  writeFileSync(file, JSON.stringify(snap, null, 1));
  console.log(`snapshot dumped: ${file} (${snap.people.length} people, ${snap.documents.length} docs)`);
} else if (mode === '--compare') {
  const before = JSON.parse(readFileSync(file, 'utf-8')) as typeof snap;
  const diffs: string[] = [];
  for (const table of [
    'people', 'identifiers', 'documents', 'encounters', 'documentMetadata',
    'contextSessions', 'contextAnswers', 'contextUploads', 'conceptAliases', 'observations',
    'derivedObservations', 'metricGroups', 'metricGroupItems', 'medications', 'timelineEvents',
    'operationLedger', 'facilities', 'decisions', 'pages',
  ] as const) {
    const a = JSON.stringify(before[table]);
    const b = JSON.stringify(snap[table]);
    if (a !== b) {
      diffs.push(table);
      console.error(`✗ ${table} 不一致`);
      console.error(`  before: ${a.slice(0, 400)}`);
      console.error(`  after : ${b.slice(0, 400)}`);
    } else {
      console.log(`✓ ${table} 一致(${snap[table].length} 行)`);
    }
  }
  if (diffs.length) {
    console.error(`重建等价性失败: ${diffs.join(', ')}`);
    process.exit(1);
  }
  console.log('重建等价性通过(A10)');
} else {
  console.error('用法: verify-rebuild --dump|--compare [file]');
  process.exit(2);
}
await sql.end();
