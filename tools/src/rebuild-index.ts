// spec m0-99 A10:仅凭桶重建数据库。输入:manifests + capture.json + _person.json + journal。
// 回放规则(与 _meta/README.md 一致):event_id 幂等;重复 add 合并;无 capture.json 佐证的 add → 对账报告。
// 前置:migrations 已跑、seed-account 已跑(account/person_access 显式在重建等价性之外)。
import { createHash } from 'node:crypto';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import {
  CaptureSidecar, ContextSession, CorrectionSidecar, EncounterDecisionPayload, EncounterProposal,
  FacilityProposal, ManifestLine, Observation, PersonSidecar, canonicalJsonString,
  correctionSortKey, idempotencyFingerprint,
} from '@amr/contracts';
import {
  CONCEPT_CATALOG_VERSION, conceptByCode, deriveObservationPlans,
  type DerivationInputFact,
} from '@amr/medical';
import { adminClient, BUCKET } from './s3-admin.js';
import {
  type HumanReplayItem, orderedUniqueHumanReplay, parseDecisionObject, parseJournalObject,
} from './human-replay.js';

const s3 = adminClient();
const sql = postgres(process.env.DATABASE_URL ?? 'postgres://amr:amr@localhost:5433/amr', {
  max: 1, onnotice: () => {},
});

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function getText(key: string): Promise<string | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await r.Body!.transformToString('utf-8');
  } catch {
    return null;
  }
}

const reconciliation: string[] = [];

// ── 1. 恢复 person(_person.json 全量快照,含 id/identifiers/archived_at)──
const personKeys = (await listKeys('people/')).filter((k) => k.endsWith('/_person.json'));
for (const key of personKeys) {
  const text = await getText(key);
  if (!text) continue;
  const p = PersonSidecar.parse(JSON.parse(text));
  await sql`
    insert into person (id, slug, display_name, name_pinyin, birth_date, sex_at_birth, gender,
                        relation_to_owner, blood_type, allergies, chronic_conditions, note,
                        created_at, updated_at, archived_at)
    values (${p.id}, ${p.slug}, ${p.display_name}, ${p.name_pinyin}, ${p.birth_date},
            ${p.sex_at_birth}, ${p.gender}, ${p.relation_to_owner}, ${p.blood_type},
            ${sql.json(p.allergies)}, ${sql.json(p.chronic_conditions)}, ${p.note},
            ${p.created_at}, ${p.updated_at}, ${p.archived_at})
    on conflict (id) do nothing
  `;
  for (const i of p.identifiers) {
    await sql`
      insert into person_identifier (id, person_id, facility_id, identifier_type, identifier_value, scope)
      values (${i.id}, ${p.id}, ${i.facility_id}, ${i.identifier_type}, ${i.identifier_value}, ${i.scope})
      on conflict (id) do nothing
    `;
  }
}
console.log(`persons restored: ${personKeys.length}`);

// ── 2. manifests 回放(event_id 幂等 → 文档)──
const manifestKeys = (await listKeys('_index/manifests/')).sort();
const seenEventIds = new Set<string>();
type AddLine = {
  doc_short_id: string;
  person_slug: string;
  prefix: string;
  created_at: string;
  origin: 'capture' | 'split';
};
const docState = new Map<string, AddLine & { finalSlug: string }>();
for (const key of manifestKeys) {
  const text = await getText(key);
  if (!text) continue;
  for (const raw of text.split('\n').filter(Boolean)) {
    const parsed = ManifestLine.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      reconciliation.push(`非法 manifest 行 (${key}): ${raw.slice(0, 120)}`);
      continue;
    }
    const line = parsed.data;
    if (seenEventIds.has(line.event_id)) continue; // 幂等
    seenEventIds.add(line.event_id);
    if (line.op === 'add') {
      const prev = docState.get(line.doc_short_id);
      docState.set(line.doc_short_id, {
        ...line, finalSlug: prev?.finalSlug ?? line.person_slug,
      });
    } else {
      const prev = docState.get(line.doc_short_id);
      if (prev) prev.finalSlug = line.to_person_slug;
      else reconciliation.push(`person_correct 无前置 add: ${line.doc_short_id}`);
    }
  }
}

// ── 3. 逐文档:capture.json 佐证 → 插 document + document_page ──
const slugToPersonId = new Map<string, string>(
  (await sql`select id, slug from person`).map((r) => [r['slug'] as string, r['id'] as string]),
);
const accountIds = new Set<string>((await sql`select id from account`).map((r) => r['id'] as string));
let docsRestored = 0;
for (const [shortId, st] of docState) {
  const captureKey = `${st.prefix}capture.json`;
  const text = await getText(captureKey);
  if (!text) {
    reconciliation.push(`add 行无 capture.json 佐证(幽灵行?): ${shortId} @ ${st.prefix}`);
    continue;
  }
  const cap = CaptureSidecar.parse(JSON.parse(text));
  const personId = slugToPersonId.get(st.finalSlug);
  if (!personId) {
    reconciliation.push(`文档归属 slug 无对应 person: ${shortId} -> ${st.finalSlug}`);
    continue;
  }
  // uploaded_by 占位账号(审核 #001 #6:account 不在重建等价性内)
  if (!accountIds.has(cap.uploaded_by)) {
    await sql`
      insert into account (id, email, password_hash, display_name)
      values (${cap.uploaded_by}, ${'rebuilt+' + cap.uploaded_by + '@local.invalid'}, '!', '重建占位账号')
      on conflict (id) do nothing
    `;
    accountIds.add(cap.uploaded_by);
  }
  // 幂等指纹从 capture.json 原样重算 —— 它的每个输入都是 L1 事实。
  // 不重算的话:重建后客户端重放同一 client_document_id 会撞 409 终止(而非 200 命中)。
  const fingerprint = cap.source === 'split' ? null : idempotencyFingerprint({
    person_id: personId,
    person_confirmed: true,
    confirmed_by: cap.person.confirmed_by,
    batch_id: '00000000-0000-7000-8000-000000000000',   // 不进指纹,占位
    source: cap.source,
    captured_at: cap.captured_at,
    client_document_id: cap.client_document_id,
    pages: cap.pages.map((pg) => ({
      upload_id: '00000000-0000-7000-8000-000000000000', // 不进指纹,占位
      page_no: pg.page_no, capture_order: pg.capture_order,
      width: pg.width, height: pg.height, sha256: pg.sha256, exif: null,
    })),
  });
  await sql`
    insert into document (id, short_id, person_id, doc_type, page_count, source, original_filename,
                          captured_at, capture_date, uploaded_by, status, client_document_id, created_at,
                          column_set)
    values (${cap.document_id}, ${shortId}, ${personId}, 'unknown', ${cap.pages.length}, ${cap.source},
            ${cap.original_filename}, ${cap.captured_at}, ${cap.capture_date}, ${cap.uploaded_by}, 'ready',
            ${cap.client_document_id}, ${cap.created_at},
            ${sql.json(fingerprint ? { idem_fingerprint: fingerprint } : {})})
    on conflict (id) do nothing
  `;
  // split capture 的 pages 是跨前缀的原件引用。源 capture 已恢复这些 page 行；
  // 此处只建目标文档骨架，页归属由后面的 page_move correction 转移，避免 storage_key 重复。
  for (const pg of st.origin === 'split' ? [] : cap.pages) {
    const storageKey = pg.file.startsWith('people/') ? pg.file : st.prefix + pg.file;
    await sql`
      insert into document_page (id, document_id, page_no, storage_key, content_sha256, byte_size,
                                 mime_type, width, height, capture_order, origin_capture_document_id,
                                 origin_capture_order, origin_object_sha256)
      values (${uuidv7()}, ${cap.document_id}, ${pg.page_no}, ${storageKey}, ${pg.sha256},
              ${pg.bytes}, ${pg.mime}, ${pg.width}, ${pg.height}, ${pg.capture_order},
              ${cap.document_id}, ${pg.capture_order}, ${pg.sha256})
      on conflict (document_id, page_no) do nothing
    `;
  }
  docsRestored += 1;
}
console.log(`documents restored: ${docsRestored}`);

// ── 4. 人工层 journal + decisions 全局回放 ──
// 先读完所有对象再按内容里的 (at,event_id) 排序；S3 LastModified 不是事实时钟。
const humanReplay: HumanReplayItem[] = [];
const journalKeys = (await listKeys('people/'))
  .filter((key) => /\/journal\/\d{4}-\d{2}\.jsonl$/.test(key));
for (const key of journalKeys) {
  const text = await getText(key);
  if (!text) continue;
  const parsed = parseJournalObject(key, text);
  humanReplay.push(...parsed.items);
  reconciliation.push(...parsed.reconciliation);
}

const decisionKeys = (await listKeys('_index/decisions/'))
  .filter((key) => /\/\d{4}-\d{2}\.jsonl$/.test(key));
for (const key of decisionKeys) {
  const text = await getText(key);
  if (!text) continue;
  const parsed = parseDecisionObject(key, text);
  humanReplay.push(...parsed.items);
  reconciliation.push(...parsed.reconciliation);
}

// encounter 的 L1 载荷携带 facility UUID 快照。先建立 slug→id 映射，确保更早
// 排序的 facility_confirm 直接用原 UUID 建词表，不产生一条随机 ID 的重复机构。
const replayFacilityIds = new Map<string, string>();
for (const item of humanReplay) {
  if (item.replayKind !== 'normalization_confirm' || item.line.kind !== 'encounter') continue;
  const payload = EncounterDecisionPayload.safeParse(item.line.payload);
  if (!payload.success) continue; // 旧版载荷稍后进入对账报告，决策行仍可恢复。
  const prior = replayFacilityIds.get(payload.data.facility.slug);
  if (prior && prior !== payload.data.facility.id) {
    reconciliation.push(`encounter 机构 slug 对应多个 UUID: ${payload.data.facility.slug}`);
    continue;
  }
  replayFacilityIds.set(payload.data.facility.slug, payload.data.facility.id);
}

async function ensurePlaceholderAccount(accountId: string): Promise<void> {
  if (accountIds.has(accountId)) return;
  await sql`
    insert into account (id, email, password_hash, display_name)
    values (${accountId}, ${'rebuilt+' + accountId + '@local.invalid'}, '!', '重建占位账号')
    on conflict (id) do nothing
  `;
  accountIds.add(accountId);
}

async function restoreFacilitySnapshot(snapshot: {
  id: string; slug: string; name: string; aliases: string[]; city: string | null; level: string | null;
} | null): Promise<void> {
  if (!snapshot) return;
  await sql`
    insert into facility (id, slug, name, aliases, city, level)
    values (${snapshot.id}, ${snapshot.slug}, ${snapshot.name}, ${snapshot.aliases}, ${snapshot.city}, ${snapshot.level})
    on conflict (id) do update set
      slug = excluded.slug, name = excluded.name, aliases = excluded.aliases,
      city = excluded.city, level = excluded.level
  `;
}

async function restoreOperationLedger(input: {
  accountId: string; clientOperationId: string; kind: string; subjectId: string;
  subjectType: string; personId: string; requestHash: string;
  response: Record<string, unknown>; at: string;
}): Promise<void> {
  await sql`
    insert into operation_ledger
      (account_id, client_operation_id, kind, subject_type, subject_id, person_id,
       request_hash, request, result, created_at)
    values
      (${input.accountId}, ${input.clientOperationId}, ${input.kind}, ${input.subjectType},
       ${input.subjectId}, ${input.personId}, ${input.requestHash}, ${sql.json({})},
       ${sql.json(input.response as postgres.JSONValue)}, ${input.at})
    on conflict (account_id, client_operation_id) do update set
      request_hash = excluded.request_hash, result = excluded.result
  `;
}

async function restoreContextSessionSnapshot(
  after: ReturnType<typeof ContextSession.parse>,
  personSlug: string,
): Promise<boolean> {
  await ensurePlaceholderAccount(after.created_by);
  await ensurePlaceholderAccount(after.updated_by);
  const owner = (await sql`
    select id from person where id = ${after.person_id} and slug = ${personSlug} limit 1
  `)[0];
  if (!owner) return false;
  if (after.document_id) {
    const doc = (await sql`
      select id from document where id = ${after.document_id} and person_id = ${after.person_id} limit 1
    `)[0];
    if (!doc) return false;
  }
  if (after.encounter_id) {
    const visit = (await sql`
      select id from encounter where id = ${after.encounter_id} and person_id = ${after.person_id} limit 1
    `)[0];
    if (!visit) return false;
  }
  await sql`
    insert into context_session
      (id, person_id, scope_type, scope_key, client_document_id, document_id, encounter_id,
       template_id, template_version, template_hash, question_snapshot, stage, status, revision,
       created_by, created_at, updated_by, updated_at, completed_at)
    values
      (${after.id}, ${after.person_id}, ${after.scope_type}, ${after.scope_key},
       ${after.client_document_id}, ${after.document_id}, ${after.encounter_id},
       ${after.template_id}, ${after.template_version}, ${after.template_hash},
       ${sql.json(after.question_snapshot as postgres.JSONValue)}, ${after.stage}, ${after.status},
       ${after.revision}, ${after.created_by}, ${after.created_at}, ${after.updated_by},
       ${after.updated_at}, ${after.completed_at})
    on conflict (id) do update set
      document_id = excluded.document_id, encounter_id = excluded.encounter_id,
      question_snapshot = excluded.question_snapshot, status = excluded.status,
      revision = excluded.revision, updated_by = excluded.updated_by,
      updated_at = excluded.updated_at, completed_at = excluded.completed_at
  `;
  return true;
}

async function restoreObservationSnapshot(
  after: ReturnType<typeof Observation.parse>,
  personSlug: string,
): Promise<boolean> {
  if (after.created_by) await ensurePlaceholderAccount(after.created_by);
  if (after.updated_by) await ensurePlaceholderAccount(after.updated_by);
  if (after.reviewed_by) await ensurePlaceholderAccount(after.reviewed_by);
  const owner = (await sql`
    select id from person where id = ${after.person_id} and slug = ${personSlug} limit 1
  `)[0];
  if (!owner) return false;
  for (const ref of [after.document_id, after.source_page?.current_document_id ?? null]) {
    if (!ref) continue;
    const doc = (await sql`
      select id from document where id = ${ref} and person_id = ${after.person_id} limit 1
    `)[0];
    if (!doc) return false;
  }
  if (after.encounter_id) {
    const visit = (await sql`
      select id from encounter where id = ${after.encounter_id} and person_id = ${after.person_id} limit 1
    `)[0];
    if (!visit) return false;
  }
  if (after.lab_facility_id) {
    const lab = (await sql`select id from facility where id = ${after.lab_facility_id} limit 1`)[0];
    if (!lab) return false;
  }

  let currentDocumentId: string | null = null;
  let currentPageNo: number | null = null;
  if (after.source_page) {
    const projection = (await sql`
      select dp.document_id, dp.page_no
      from document_page dp
      inner join document d on d.id = dp.document_id
      where d.person_id = ${after.person_id}
        and dp.origin_capture_document_id = ${after.source_page.origin_capture_document_id}
        and dp.origin_capture_order = ${after.source_page.origin_capture_order}
        and dp.origin_object_sha256 = ${after.source_page.object_sha256}
      limit 1
    `)[0];
    currentDocumentId = projection?.['document_id'] as string | undefined ?? null;
    currentPageNo = projection?.['page_no'] as number | undefined ?? null;
  }
  const source = after.source_page;
  await sql`
    insert into observation
      (id, person_id, document_id, encounter_id, client_row_id, observed_on, observed_at,
       time_precision, date_source, local_name, mapping_fingerprint, concept_code,
       concept_catalog_version, loinc_code,
       qualifier, body_site, extra_dims, series_key, value_raw, value_num, comparator, value_text,
       value_dimensions, unit_raw, unit_ucum, value_si, unit_si, conversion_version,
       ref_low, ref_high, ref_text, ref_unit, abnormal_flag_raw, abnormal_flag,
       specimen, specimen_label, method, device, measurement_setting, result_kind,
       collected_at, reported_at, lab_facility_id, origin_capture_document_id,
       origin_capture_order, object_sha256, logical_page_index, source_bbox,
       current_document_id, current_page_no, source, source_ref, review_status, reviewed_by,
       reviewed_at, consistency_flags, is_derived, derived_formula, calculation_version,
       derivation_key, input_observation_ids, input_revision_hash, revision, created_by,
       created_at, updated_by, updated_at, archived_at)
    values
      (${after.id}, ${after.person_id}, ${after.document_id}, ${after.encounter_id},
       ${after.client_row_id}, ${after.observed_on}, ${after.observed_at}, ${after.time_precision},
       ${after.date_source}, ${after.local_name}, ${createHash('sha256').update(canonicalJsonString({
         local_name: after.local_name.normalize('NFKC').trim().toLocaleLowerCase('zh-CN'),
         specimen: after.specimen, method: after.method,
       })).digest('hex')}, ${after.concept_code},
       ${after.concept_catalog_version}, ${after.loinc_code}, ${after.qualifier}, ${after.body_site},
       ${sql.json(after.extra_dims as postgres.JSONValue)}, ${after.series_key}, ${after.value_raw},
       ${after.value_num}, ${after.comparator}, ${after.value_text},
       ${sql.json(after.value_dimensions as postgres.JSONValue)}, ${after.unit_raw}, ${after.unit_ucum},
       ${after.value_si}, ${after.unit_si}, ${after.conversion_version}, ${after.ref_low},
       ${after.ref_high}, ${after.ref_text}, ${after.ref_unit}, ${after.abnormal_flag_raw},
       ${after.abnormal_flag}, ${after.specimen}, ${after.specimen_label}, ${after.method},
       ${after.device}, ${after.measurement_setting}, ${after.result_kind}, ${after.collected_at},
       ${after.reported_at}, ${after.lab_facility_id}, ${source?.origin_capture_document_id ?? null},
       ${source?.origin_capture_order ?? null}, ${source?.object_sha256 ?? null},
       ${source?.logical_page_index ?? null}, ${sql.json((source?.bbox ?? null) as postgres.JSONValue)},
       ${currentDocumentId}, ${currentPageNo}, ${after.source},
       ${sql.json(after.source_ref as postgres.JSONValue)}, ${after.review_status},
       ${after.reviewed_by}, ${after.reviewed_at}, ${after.consistency_flags}, ${after.is_derived},
       ${after.derived_formula}, ${after.calculation_version}, ${after.derivation_key},
       ${after.input_observation_ids}, ${after.input_revision_hash}, ${after.revision},
       ${after.created_by}, ${after.created_at}, ${after.updated_by}, ${after.updated_at},
       ${after.archived_at})
    on conflict (id) do update set
      document_id = excluded.document_id, encounter_id = excluded.encounter_id,
      observed_on = excluded.observed_on, observed_at = excluded.observed_at,
      time_precision = excluded.time_precision, date_source = excluded.date_source,
      local_name = excluded.local_name, mapping_fingerprint = excluded.mapping_fingerprint,
      concept_code = excluded.concept_code,
      concept_catalog_version = excluded.concept_catalog_version, loinc_code = excluded.loinc_code,
      qualifier = excluded.qualifier, body_site = excluded.body_site, extra_dims = excluded.extra_dims,
      series_key = excluded.series_key, value_raw = excluded.value_raw, value_num = excluded.value_num,
      comparator = excluded.comparator, value_text = excluded.value_text,
      value_dimensions = excluded.value_dimensions, unit_raw = excluded.unit_raw,
      unit_ucum = excluded.unit_ucum, value_si = excluded.value_si, unit_si = excluded.unit_si,
      conversion_version = excluded.conversion_version, ref_low = excluded.ref_low,
      ref_high = excluded.ref_high, ref_text = excluded.ref_text, ref_unit = excluded.ref_unit,
      abnormal_flag_raw = excluded.abnormal_flag_raw, abnormal_flag = excluded.abnormal_flag,
      specimen = excluded.specimen, specimen_label = excluded.specimen_label,
      method = excluded.method, device = excluded.device,
      measurement_setting = excluded.measurement_setting, result_kind = excluded.result_kind,
      collected_at = excluded.collected_at, reported_at = excluded.reported_at,
      lab_facility_id = excluded.lab_facility_id,
      origin_capture_document_id = excluded.origin_capture_document_id,
      origin_capture_order = excluded.origin_capture_order, object_sha256 = excluded.object_sha256,
      logical_page_index = excluded.logical_page_index, source_bbox = excluded.source_bbox,
      current_document_id = excluded.current_document_id, current_page_no = excluded.current_page_no,
      source = excluded.source, source_ref = excluded.source_ref,
      review_status = excluded.review_status, reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at, consistency_flags = excluded.consistency_flags,
      is_derived = excluded.is_derived, derived_formula = excluded.derived_formula,
      calculation_version = excluded.calculation_version, derivation_key = excluded.derivation_key,
      input_observation_ids = excluded.input_observation_ids,
      input_revision_hash = excluded.input_revision_hash, revision = excluded.revision,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at,
      archived_at = excluded.archived_at
  `;
  return true;
}

async function currentStableProjection(input: {
  personId: string;
  sourcePage: {
    origin_capture_document_id: string; origin_capture_order: number;
    object_sha256: string; logical_page_index: number;
  } | null;
}): Promise<{ currentDocumentId: string | null; currentPageNo: number | null }> {
  if (!input.sourcePage) return { currentDocumentId: null, currentPageNo: null };
  const projection = (await sql`
    select dp.document_id, dp.page_no
    from document_page dp
    inner join document d on d.id = dp.document_id
    where d.person_id = ${input.personId}
      and dp.origin_capture_document_id = ${input.sourcePage.origin_capture_document_id}
      and dp.origin_capture_order = ${input.sourcePage.origin_capture_order}
      and dp.origin_object_sha256 = ${input.sourcePage.object_sha256}
    limit 1
  `)[0];
  return {
    currentDocumentId: projection?.['document_id'] as string | undefined ?? null,
    currentPageNo: projection?.['page_no'] as number | undefined ?? null,
  };
}

async function restoreMedicationSnapshot(
  after: Extract<HumanReplayItem, { replayKind: 'medication_upsert' }>['line']['after'][number],
  personSlug: string,
): Promise<boolean> {
  await ensurePlaceholderAccount(after.created_by);
  await ensurePlaceholderAccount(after.updated_by);
  const owner = (await sql`
    select id from person where id = ${after.person_id} and slug = ${personSlug} limit 1
  `)[0];
  if (!owner) return false;
  if (after.encounter_id) {
    const visit = (await sql`
      select id from encounter where id = ${after.encounter_id} and person_id = ${after.person_id} limit 1
    `)[0];
    if (!visit) return false;
  }
  const source = after.source_page;
  if (source) {
    const originOwner = (await sql`
      select id from document
      where id = ${source.origin_capture_document_id} and person_id = ${after.person_id} limit 1
    `)[0];
    if (!originOwner) return false;
  }
  const current = await currentStableProjection({ personId: after.person_id, sourcePage: source });
  await sql`
    insert into medication
      (id, person_id, encounter_id, client_row_id, kind, name_raw, generic_name, dose_raw,
       dose_value, dose_unit, concentration_pct, solute_mass_g, frequency_raw, route,
       administration_group, group_volume_ml, sequence, administered_at, started_on, ended_on,
       origin_capture_document_id, origin_capture_order, object_sha256, logical_page_index,
       source_bbox, current_document_id, current_page_no, note, source, source_ref, revision,
       created_by, created_at, updated_by, updated_at, archived_at)
    values
      (${after.id}, ${after.person_id}, ${after.encounter_id}, ${after.client_row_id}, ${after.kind},
       ${after.name_raw}, ${after.generic_name}, ${after.dose_raw}, ${after.dose_value},
       ${after.dose_unit}, ${after.concentration_pct}, ${after.solute_mass_g},
       ${after.frequency_raw}, ${after.route}, ${after.administration_group},
       ${after.group_volume_ml}, ${after.sequence}, ${after.administered_at}, ${after.started_on},
       ${after.ended_on}, ${source?.origin_capture_document_id ?? null},
       ${source?.origin_capture_order ?? null}, ${source?.object_sha256 ?? null},
       ${source?.logical_page_index ?? null},
       ${sql.json((source?.bbox ?? null) as postgres.JSONValue)}, ${current.currentDocumentId},
       ${current.currentPageNo}, ${after.note}, ${after.source},
       ${sql.json(after.source_ref as postgres.JSONValue)}, ${after.revision}, ${after.created_by},
       ${after.created_at}, ${after.updated_by}, ${after.updated_at}, ${after.archived_at})
    on conflict (id) do update set
      encounter_id = excluded.encounter_id, kind = excluded.kind, name_raw = excluded.name_raw,
      generic_name = excluded.generic_name, dose_raw = excluded.dose_raw,
      dose_value = excluded.dose_value, dose_unit = excluded.dose_unit,
      concentration_pct = excluded.concentration_pct, solute_mass_g = excluded.solute_mass_g,
      frequency_raw = excluded.frequency_raw, route = excluded.route,
      administration_group = excluded.administration_group,
      group_volume_ml = excluded.group_volume_ml, sequence = excluded.sequence,
      administered_at = excluded.administered_at, started_on = excluded.started_on,
      ended_on = excluded.ended_on, origin_capture_document_id = excluded.origin_capture_document_id,
      origin_capture_order = excluded.origin_capture_order, object_sha256 = excluded.object_sha256,
      logical_page_index = excluded.logical_page_index, source_bbox = excluded.source_bbox,
      current_document_id = excluded.current_document_id, current_page_no = excluded.current_page_no,
      note = excluded.note, source = excluded.source, source_ref = excluded.source_ref,
      revision = excluded.revision, updated_by = excluded.updated_by,
      updated_at = excluded.updated_at, archived_at = excluded.archived_at
  `;
  return true;
}

async function restoreTimelineEventSnapshot(
  after: Extract<HumanReplayItem, { replayKind: 'timeline_event_upsert' }>['line']['after'],
  personSlug: string,
): Promise<boolean> {
  await ensurePlaceholderAccount(after.created_by);
  await ensurePlaceholderAccount(after.updated_by);
  const owner = (await sql`
    select id from person where id = ${after.person_id} and slug = ${personSlug} limit 1
  `)[0];
  if (!owner) return false;
  if (after.encounter_id) {
    const visit = (await sql`
      select id from encounter where id = ${after.encounter_id} and person_id = ${after.person_id} limit 1
    `)[0];
    if (!visit) return false;
  }
  const source = after.source_page;
  if (source) {
    const originOwner = (await sql`
      select id from document
      where id = ${source.origin_capture_document_id} and person_id = ${after.person_id} limit 1
    `)[0];
    if (!originOwner) return false;
  }
  const current = await currentStableProjection({ personId: after.person_id, sourcePage: source });
  await sql`
    insert into timeline_event
      (id, person_id, encounter_id, kind, title, occurred_on, occurred_at, time_precision, note,
       origin_capture_document_id, origin_capture_order, object_sha256, logical_page_index,
       source_bbox, current_document_id, current_page_no, source, source_ref, revision,
       created_by, created_at, updated_by, updated_at, archived_at)
    values
      (${after.id}, ${after.person_id}, ${after.encounter_id}, ${after.kind}, ${after.title},
       ${after.occurred_on}, ${after.occurred_at}, ${after.time_precision}, ${after.note},
       ${source?.origin_capture_document_id ?? null}, ${source?.origin_capture_order ?? null},
       ${source?.object_sha256 ?? null}, ${source?.logical_page_index ?? null},
       ${sql.json((source?.bbox ?? null) as postgres.JSONValue)}, ${current.currentDocumentId},
       ${current.currentPageNo}, ${after.source}, ${sql.json(after.source_ref as postgres.JSONValue)},
       ${after.revision}, ${after.created_by}, ${after.created_at}, ${after.updated_by},
       ${after.updated_at}, ${after.archived_at})
    on conflict (id) do update set
      encounter_id = excluded.encounter_id, kind = excluded.kind, title = excluded.title,
      occurred_on = excluded.occurred_on, occurred_at = excluded.occurred_at,
      time_precision = excluded.time_precision, note = excluded.note,
      origin_capture_document_id = excluded.origin_capture_document_id,
      origin_capture_order = excluded.origin_capture_order, object_sha256 = excluded.object_sha256,
      logical_page_index = excluded.logical_page_index, source_bbox = excluded.source_bbox,
      current_document_id = excluded.current_document_id, current_page_no = excluded.current_page_no,
      source = excluded.source, source_ref = excluded.source_ref, revision = excluded.revision,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at,
      archived_at = excluded.archived_at
  `;
  return true;
}

let humanEventsReplayed = 0;
for (const item of orderedUniqueHumanReplay(humanReplay, seenEventIds)) {
  if (item.replayKind === 'document_metadata_upsert') {
    await ensurePlaceholderAccount(item.line.by_account_id);
    await ensurePlaceholderAccount(item.line.after.updated_by);
    await restoreFacilitySnapshot(item.line.references.facility);
    const doc = (await sql`
      select d.id, d.person_id from document d
      inner join person p on p.id = d.person_id
      where d.id = ${item.line.after.document_id} and p.slug = ${item.line.person_slug}
      limit 1
    `)[0];
    if (!doc) {
      reconciliation.push(`document_metadata_upsert 文档不存在或归属不匹配: ${item.line.subject_id}`);
      continue;
    }
    const after = item.line.after;
    await sql`
      insert into document_manual_metadata
        (document_id, doc_type, sampled_on, reported_on, facility_id, facility_name_raw,
         department, title, note, field_provenance, revision, updated_by, updated_at)
      values
        (${after.document_id}, ${after.doc_type}, ${after.sampled_on}, ${after.reported_on},
         ${after.facility_id}, ${after.facility_name_raw}, ${after.department}, ${after.title},
         ${after.note}, ${sql.json(after.field_provenance as postgres.JSONValue)},
         ${after.revision}, ${after.updated_by}, ${after.updated_at})
      on conflict (document_id) do update set
        doc_type = excluded.doc_type, sampled_on = excluded.sampled_on,
        reported_on = excluded.reported_on, facility_id = excluded.facility_id,
        facility_name_raw = excluded.facility_name_raw, department = excluded.department,
        title = excluded.title, note = excluded.note,
        field_provenance = excluded.field_provenance, revision = excluded.revision,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `;
    await restoreOperationLedger({
      accountId: item.line.by_account_id, clientOperationId: item.line.client_operation_id,
      kind: item.line.event, subjectId: item.line.subject_id, personId: doc['person_id'] as string,
      subjectType: 'document',
      requestHash: item.line.operation_replay.request_hash,
      response: item.line.operation_replay.response_snapshot, at: item.line.at,
    });
    humanEventsReplayed += 1;
    continue;
  }

  if (item.replayKind === 'encounter_upsert' || item.replayKind === 'encounter_documents_set') {
    await ensurePlaceholderAccount(item.line.by_account_id);
    if (item.line.after.updated_by) await ensurePlaceholderAccount(item.line.after.updated_by);
    await restoreFacilitySnapshot(item.line.references.facility);
    const after = item.line.after;
    await sql`
      insert into encounter
        (id, person_id, encounter_type, facility_id, department, occurred_on, ended_on,
         occurred_at, chief_complaint, diagnosis_text, doctor_advice, created_at,
         revision, updated_by, updated_at, archived_at)
      values
        (${after.id}, ${after.person_id}, ${after.encounter_type}, ${after.facility_id},
         ${after.department}, ${after.occurred_on}, ${after.ended_on}, ${after.occurred_at},
         ${after.chief_complaint}, ${after.diagnosis_text}, ${after.doctor_advice},
         ${after.created_at}, ${after.revision}, ${after.updated_by}, ${after.updated_at},
         ${after.archived_at})
      on conflict (id) do update set
        encounter_type = excluded.encounter_type, facility_id = excluded.facility_id,
        department = excluded.department, occurred_on = excluded.occurred_on,
        ended_on = excluded.ended_on, occurred_at = excluded.occurred_at,
        chief_complaint = excluded.chief_complaint,
        diagnosis_text = excluded.diagnosis_text, doctor_advice = excluded.doctor_advice,
        revision = excluded.revision, updated_by = excluded.updated_by,
        updated_at = excluded.updated_at, archived_at = excluded.archived_at
    `;
    if (item.replayKind === 'encounter_documents_set') {
      const members = item.line.after_document_ids.length === 0 ? [] : await sql`
        select id from document
        where id in ${sql(item.line.after_document_ids)} and person_id = ${after.person_id}
      `;
      if (members.length !== item.line.after_document_ids.length) {
        reconciliation.push(`encounter_documents_set 含缺失或跨人文档: ${after.id}`);
        continue;
      }
      await sql`update document set encounter_id = null where encounter_id = ${after.id}`;
      if (item.line.after_document_ids.length > 0) {
        await sql`update document set encounter_id = ${after.id} where id in ${sql(item.line.after_document_ids)}`;
      }
    }
    await restoreOperationLedger({
      accountId: item.line.by_account_id, clientOperationId: item.line.client_operation_id,
      kind: item.line.event, subjectId: item.line.subject_id, personId: after.person_id,
      subjectType: 'encounter',
      requestHash: item.line.operation_replay.request_hash,
      response: item.line.operation_replay.response_snapshot, at: item.line.at,
    });
    humanEventsReplayed += 1;
    continue;
  }

  if (item.replayKind === 'context_session_upsert') {
    await ensurePlaceholderAccount(item.line.by_account_id);
    const restored = await restoreContextSessionSnapshot(item.line.after, item.line.person_slug);
    if (!restored) {
      reconciliation.push(`context_session_upsert 引用缺失或跨人: ${item.line.subject_id}`);
      continue;
    }
    await restoreOperationLedger({
      accountId: item.line.by_account_id, clientOperationId: item.line.client_operation_id,
      kind: item.line.event, subjectId: item.line.subject_id, personId: item.line.after.person_id,
      subjectType: 'context_session', requestHash: item.line.operation_replay.request_hash,
      response: item.line.operation_replay.response_snapshot, at: item.line.at,
    });
    humanEventsReplayed += 1;
    continue;
  }

  if (item.replayKind === 'context_media_finalize') {
    await ensurePlaceholderAccount(item.line.by_account_id);
    await ensurePlaceholderAccount(item.line.after.created_by);
    const after = item.line.after;
    const session = (await sql`
      select cs.id from context_session cs
      inner join person p on p.id = cs.person_id
      where cs.id = ${after.session_id} and cs.person_id = ${after.person_id}
        and p.slug = ${item.line.person_slug}
      limit 1
    `)[0];
    const expectedPrefix = `people/${item.line.person_slug}/context/${after.session_id}/`;
    if (!session || !after.object_key.startsWith(expectedPrefix)) {
      reconciliation.push(`context_media_finalize 引用缺失、跨人或 key 越界: ${after.id}`);
      continue;
    }
    await sql`
      insert into context_upload
        (id, person_id, session_id, question_key, kind, mime, byte_size, sha256,
         object_key, state, multipart_state, created_by, created_at, finalized_at)
      values
        (${after.id}, ${after.person_id}, ${after.session_id}, ${after.question_key},
         ${after.kind}, ${after.mime}, ${after.byte_size}, ${after.sha256}, ${after.object_key},
         ${after.state}, ${sql.json(after.multipart_state as postgres.JSONValue)},
         ${after.created_by}, ${after.created_at}, ${after.finalized_at})
      on conflict (id) do update set
        state = excluded.state, multipart_state = excluded.multipart_state,
        finalized_at = excluded.finalized_at
    `;
    await restoreOperationLedger({
      accountId: item.line.by_account_id, clientOperationId: item.line.client_operation_id,
      kind: item.line.event, subjectId: item.line.subject_id, personId: after.person_id,
      subjectType: 'context_upload', requestHash: item.line.operation_replay.request_hash,
      response: item.line.operation_replay.response_snapshot, at: item.line.at,
    });
    humanEventsReplayed += 1;
    continue;
  }

  if (item.replayKind === 'context_answer_upsert') {
    await ensurePlaceholderAccount(item.line.by_account_id);
    const sessionRestored = await restoreContextSessionSnapshot(
      item.line.session_after, item.line.person_slug,
    );
    if (!sessionRestored) {
      reconciliation.push(`context_answer_upsert session 引用缺失或跨人: ${item.line.subject_id}`);
      continue;
    }
    let valid = true;
    for (const after of item.line.after) {
      await ensurePlaceholderAccount(after.updated_by);
      if (after.upload_id) {
        const upload = (await sql`
          select id from context_upload
          where id = ${after.upload_id} and session_id = ${after.session_id}
            and question_key = ${after.question_key} and state = 'finalized'
          limit 1
        `)[0];
        if (!upload) {
          reconciliation.push(`context_answer_upsert 媒体引用缺失或不匹配: ${after.id}`);
          valid = false;
          break;
        }
      }
    }
    if (!valid) continue;
    for (const after of item.line.after) {
      const storedValue = after.upload_id ? null : after.value;
      await sql`
        insert into context_answer
          (id, session_id, question_key, question_text, question_snapshot, answer_type, value,
           upload_id, skipped, answered_at, event_on, event_at, time_precision,
           event_time_source, revision, updated_by, updated_at)
        values
          (${after.id}, ${after.session_id}, ${after.question_key}, ${after.question_text},
           ${sql.json(after.question_snapshot as postgres.JSONValue)}, ${after.answer_type},
           ${sql.json(storedValue as postgres.JSONValue)}, ${after.upload_id}, ${after.skipped},
           ${after.answered_at}, ${after.event_on}, ${after.event_at}, ${after.time_precision},
           ${after.event_time_source}, ${after.revision}, ${after.updated_by}, ${after.updated_at})
        on conflict (session_id, question_key) do update set
          question_text = excluded.question_text, question_snapshot = excluded.question_snapshot,
          answer_type = excluded.answer_type, value = excluded.value, upload_id = excluded.upload_id,
          skipped = excluded.skipped, answered_at = excluded.answered_at,
          event_on = excluded.event_on, event_at = excluded.event_at,
          time_precision = excluded.time_precision, event_time_source = excluded.event_time_source,
          revision = excluded.revision, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `;
    }
    await restoreOperationLedger({
      accountId: item.line.by_account_id, clientOperationId: item.line.client_operation_id,
      kind: item.line.event, subjectId: item.line.subject_id,
      personId: item.line.session_after.person_id, subjectType: 'context_session',
      requestHash: item.line.operation_replay.request_hash,
      response: item.line.operation_replay.response_snapshot, at: item.line.at,
    });
    humanEventsReplayed += 1;
    continue;
  }

  if (item.replayKind === 'observation_upsert') {
    await ensurePlaceholderAccount(item.line.by_account_id);
    for (const snapshot of item.line.references.facilities) {
      await restoreFacilitySnapshot(snapshot);
    }
    let restored = true;
    for (const after of item.line.after) {
      if (!await restoreObservationSnapshot(after, item.line.person_slug)) {
        reconciliation.push(`observation_upsert 引用缺失或跨人: ${after.id}`);
        restored = false;
        break;
      }
    }
    if (!restored) continue;
    await restoreOperationLedger({
      accountId: item.line.by_account_id, clientOperationId: item.line.client_operation_id,
      kind: item.line.event, subjectId: item.line.subject_id,
      personId: item.line.after[0]!.person_id, subjectType: 'observation',
      requestHash: item.line.operation_replay.request_hash,
      response: item.line.operation_replay.response_snapshot, at: item.line.at,
    });
    humanEventsReplayed += 1;
    continue;
  }

  if (item.replayKind === 'concept_alias_upsert') {
    await ensurePlaceholderAccount(item.line.by_account_id);
    await ensurePlaceholderAccount(item.line.after.decided_by);
    const owner = (await sql`
      select id from person where id = ${item.line.after.person_id}
        and slug = ${item.line.person_slug} limit 1
    `)[0];
    if (!owner) {
      reconciliation.push(`concept_alias_upsert 人员不存在或归属不匹配: ${item.line.after.id}`);
      continue;
    }
    const after = item.line.after;
    await sql`
      insert into concept_alias_decision
        (id, person_id, input_fingerprint, local_name, context, concept_code, display_name,
         catalog_version, state, revision, decided_by, decided_at, updated_at)
      values
        (${after.id}, ${after.person_id}, ${after.input_fingerprint}, ${after.local_name},
         ${sql.json(after.context as postgres.JSONValue)}, ${after.concept_code},
         ${after.display_name}, ${after.catalog_version}, ${after.state}, ${after.revision},
         ${after.decided_by}, ${after.decided_at}, ${after.updated_at})
      on conflict (id) do update set
        concept_code = excluded.concept_code, display_name = excluded.display_name,
        catalog_version = excluded.catalog_version, state = excluded.state,
        revision = excluded.revision, decided_by = excluded.decided_by,
        decided_at = excluded.decided_at, updated_at = excluded.updated_at
    `;
    let restored = true;
    for (const observationAfter of item.line.observations_after) {
      if (!await restoreObservationSnapshot(observationAfter, item.line.person_slug)) {
        reconciliation.push(`concept_alias_upsert observation 引用缺失: ${observationAfter.id}`);
        restored = false;
        break;
      }
    }
    if (!restored) continue;
    await restoreOperationLedger({
      accountId: item.line.by_account_id, clientOperationId: item.line.client_operation_id,
      kind: item.line.event, subjectId: item.line.subject_id,
      personId: after.person_id, subjectType: 'concept_alias',
      requestHash: item.line.operation_replay.request_hash,
      response: item.line.operation_replay.response_snapshot, at: item.line.at,
    });
    humanEventsReplayed += 1;
    continue;
  }

  if (item.replayKind === 'metric_group_upsert' || item.replayKind === 'metric_group_archive') {
    const after = item.line.after;
    await ensurePlaceholderAccount(item.line.by_account_id);
    await ensurePlaceholderAccount(after.created_by);
    await ensurePlaceholderAccount(after.updated_by);
    const owner = (await sql`
      select id from person where id = ${after.person_id}
        and slug = ${item.line.person_slug} limit 1
    `)[0];
    if (!owner) {
      reconciliation.push(`${item.replayKind} 人员不存在或归属不匹配: ${after.id}`);
      continue;
    }
    await sql`
      insert into metric_group
        (id, person_id, name, description, preset_origin, revision, created_by, created_at,
         updated_by, updated_at, archived_at)
      values
        (${after.id}, ${after.person_id}, ${after.name}, ${after.description},
         ${after.preset_origin}, ${after.revision}, ${after.created_by}, ${after.created_at},
         ${after.updated_by}, ${after.updated_at}, ${after.archived_at})
      on conflict (id) do update set
        name = excluded.name, description = excluded.description,
        preset_origin = excluded.preset_origin, revision = excluded.revision,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at,
        archived_at = excluded.archived_at
    `;
    await sql`delete from metric_group_item where metric_group_id = ${after.id}`;
    for (const groupItem of after.items) {
      await sql`
        insert into metric_group_item
          (id, metric_group_id, position, item_type, concept_code, qualifier, body_site,
           specimen, method, device, measurement_setting, extra_dims, result_kind,
           series_selector_hash)
        values
          (${groupItem.id}, ${after.id}, ${groupItem.position}, ${groupItem.item_type},
           ${groupItem.selector.concept_code}, ${groupItem.selector.qualifier},
           ${groupItem.selector.body_site}, ${groupItem.selector.specimen},
           ${groupItem.selector.method}, ${groupItem.selector.device},
           ${groupItem.selector.measurement_setting},
           ${sql.json(groupItem.selector.extra_dims as postgres.JSONValue)},
           ${groupItem.selector.result_kind}, ${groupItem.series_selector_hash})
      `;
    }
    await restoreOperationLedger({
      accountId: item.line.by_account_id, clientOperationId: item.line.client_operation_id,
      kind: item.line.event, subjectId: item.line.subject_id,
      personId: after.person_id, subjectType: 'metric_group',
      requestHash: item.line.operation_replay.request_hash,
      response: item.line.operation_replay.response_snapshot, at: item.line.at,
    });
    humanEventsReplayed += 1;
    continue;
  }

  if (item.replayKind === 'medication_upsert') {
    await ensurePlaceholderAccount(item.line.by_account_id);
    let restored = true;
    for (const after of item.line.after) {
      if (!await restoreMedicationSnapshot(after, item.line.person_slug)) {
        reconciliation.push(`medication_upsert 引用缺失或跨人: ${after.id}`);
        restored = false;
        break;
      }
    }
    if (!restored) continue;
    await restoreOperationLedger({
      accountId: item.line.by_account_id, clientOperationId: item.line.client_operation_id,
      kind: item.line.event, subjectId: item.line.subject_id,
      personId: item.line.after[0]!.person_id,
      subjectType: item.line.before.length === 0 ? 'medication_batch' : 'medication',
      requestHash: item.line.operation_replay.request_hash,
      response: item.line.operation_replay.response_snapshot, at: item.line.at,
    });
    humanEventsReplayed += 1;
    continue;
  }

  if (item.replayKind === 'timeline_event_upsert') {
    await ensurePlaceholderAccount(item.line.by_account_id);
    if (!await restoreTimelineEventSnapshot(item.line.after, item.line.person_slug)) {
      reconciliation.push(`timeline_event_upsert 引用缺失或跨人: ${item.line.after.id}`);
      continue;
    }
    await restoreOperationLedger({
      accountId: item.line.by_account_id, clientOperationId: item.line.client_operation_id,
      kind: item.line.event, subjectId: item.line.subject_id,
      personId: item.line.after.person_id, subjectType: 'timeline_event',
      requestHash: item.line.operation_replay.request_hash,
      response: item.line.operation_replay.response_snapshot, at: item.line.at,
    });
    humanEventsReplayed += 1;
    continue;
  }

  if (item.replayKind === 'document_archive') {
    const updated = await sql`
      update document set archived_at = ${item.line.archived ? item.line.at : null}
      where short_id = ${item.line.document_short_id}
      returning id
    `;
    if (updated.length === 0) {
      reconciliation.push(
        `document_archive 文档不存在: ${item.line.document_short_id} (${item.sourceKey})`,
      );
      continue;
    }
    humanEventsReplayed += 1;
    continue;
  }

  if (item.replayKind === 'person_check_ack') {
    const updated = await sql`
      update document set person_check_ack_at = ${item.line.at}
      where short_id = ${item.line.document_short_id}
      returning id
    `;
    if (updated.length === 0) {
      reconciliation.push(
        `person_check_ack 文档不存在: ${item.line.document_short_id} (${item.sourceKey})`,
      );
      continue;
    }
    humanEventsReplayed += 1;
    continue;
  }

  if (item.replayKind !== 'normalization_confirm') continue;

  await ensurePlaceholderAccount(item.line.by_account_id);
  let decisionProposal: Record<string, unknown> = item.line.payload;
  let encounterPayload: ReturnType<typeof EncounterDecisionPayload.parse> | null = null;
  if (item.line.kind === 'encounter') {
    const enriched = EncounterDecisionPayload.safeParse(item.line.payload);
    if (enriched.success) {
      encounterPayload = enriched.data;
      const { facility: _facility, ...proposal } = enriched.data;
      decisionProposal = EncounterProposal.parse(proposal);
    } else {
      const legacy = EncounterProposal.safeParse(item.line.payload);
      if (legacy.success) decisionProposal = legacy.data;
    }
  }
  await sql`
    insert into normalization_decision
      (id, kind, input_fingerprint, proposal, state, decided_by, decided_at,
       client_operation_id, created_at)
    values
      (${uuidv7()}, ${item.line.kind}, ${item.line.input_fingerprint},
       ${sql.json(decisionProposal as postgres.JSONValue)},
       ${item.line.decision}, ${item.line.by_account_id}, ${item.line.at},
       ${item.line.client_operation_id}, ${item.line.at})
    on conflict (input_fingerprint) do update set
      kind = excluded.kind,
      proposal = excluded.proposal,
      state = excluded.state,
      decided_by = excluded.decided_by,
      decided_at = excluded.decided_at,
      client_operation_id = excluded.client_operation_id
  `;

  if (item.line.kind === 'facility' && item.line.decision === 'confirmed') {
    const proposal = FacilityProposal.safeParse(item.line.payload);
    if (!proposal.success) {
      reconciliation.push(`facility decision 载荷非法 (${item.sourceKey}): ${item.line.input_fingerprint}`);
      continue;
    }
    const existing = (await sql`
      select id, aliases from facility where slug = ${proposal.data.facility.slug} limit 1
    `)[0];
    if (!existing) {
      const facilityId = replayFacilityIds.get(proposal.data.facility.slug) ?? uuidv7();
      await sql`
        insert into facility (id, slug, name, aliases, city, level)
        values (${facilityId}, ${proposal.data.facility.slug}, ${proposal.data.facility.name},
                ${proposal.data.matched_raw_names}, ${proposal.data.facility.city},
                ${proposal.data.facility.level})
      `;
    } else {
      const aliases = [...new Set([
        ...existing['aliases'] as string[], ...proposal.data.matched_raw_names,
      ])];
      await sql`
        update facility set name = ${proposal.data.facility.name}, aliases = ${aliases},
                            city = ${proposal.data.facility.city}, level = ${proposal.data.facility.level}
        where id = ${existing['id'] as string}
      `;
    }
  }

  if (item.line.kind === 'encounter' && item.line.decision === 'confirmed') {
    if (!encounterPayload) {
      reconciliation.push(
        `encounter decision 缺机构快照，无法执行旧版确认 (${item.sourceKey}): ${item.line.input_fingerprint}`,
      );
      continue;
    }
    const snapshot = encounterPayload.facility;
    const facilityRow = (await sql`select id from facility where id = ${snapshot.id} limit 1`)[0];
    if (!facilityRow) {
      await sql`
        insert into facility (id, slug, name, aliases, city, level)
        values (${snapshot.id}, ${snapshot.slug}, ${snapshot.name}, ${snapshot.aliases},
                ${snapshot.city}, ${snapshot.level})
      `;
    }
    const memberRows = await sql`
      select id, person_id from document where id in ${sql(encounterPayload.document_ids)}
    `;
    if (memberRows.length !== encounterPayload.document_ids.length
        || memberRows.some((row) => row['person_id'] !== encounterPayload!.person_id)) {
      reconciliation.push(
        `encounter decision 文档骨架或归属不匹配 (${item.sourceKey}): ${encounterPayload.encounter_id}`,
      );
      continue;
    }
    await sql`
      insert into encounter
        (id, person_id, encounter_type, facility_id, department, occurred_on, occurred_at,
         grouping_basis, revision, updated_by, updated_at)
      values
        (${encounterPayload.encounter_id}, ${encounterPayload.person_id},
         ${encounterPayload.encounter_type}, ${snapshot.id}, ${encounterPayload.department},
         ${encounterPayload.occurred_on}, ${encounterPayload.occurred_at},
         ${encounterPayload.grouping_basis}, 1, ${item.line.by_account_id}, ${item.line.at})
      on conflict (id) do update set
        person_id = excluded.person_id,
        encounter_type = excluded.encounter_type,
        facility_id = excluded.facility_id,
        department = excluded.department,
        occurred_on = excluded.occurred_on,
        occurred_at = excluded.occurred_at,
        grouping_basis = excluded.grouping_basis,
        revision = excluded.revision,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `;
    await sql`
      update document set encounter_id = ${encounterPayload.encounter_id}
      where id in ${sql(encounterPayload.document_ids)}
    `;
  }
  humanEventsReplayed += 1;
}
console.log(`human events replayed: ${humanEventsReplayed}`);

// ── 5. page_move correction 全局回放 ──
const correctionKeys = (await listKeys('people/'))
  .filter((key) => /\/correction-\d{4}\.json$/.test(key));
const pageMoves: Array<{ key: string; sidecar: Extract<ReturnType<typeof CorrectionSidecar.parse>, { kind: 'page_move' }> }> = [];
for (const key of correctionKeys) {
  const text = await getText(key);
  if (!text) continue;
  const parsed = CorrectionSidecar.safeParse(JSON.parse(text));
  if (!parsed.success) {
    reconciliation.push(`非法 correction sidecar: ${key}`);
    continue;
  }
  if (parsed.data.kind === 'page_move') pageMoves.push({ key, sidecar: parsed.data });
}
pageMoves.sort((a, b) => correctionSortKey(a.sidecar, a.sidecar.from_doc_short_id)
  .localeCompare(correctionSortKey(b.sidecar, b.sidecar.from_doc_short_id)));

async function normalizeRebuiltPages(documentId: string): Promise<number> {
  const rows = await sql`
    select id from document_page where document_id = ${documentId} order by page_no, id
  `;
  if (rows.length > 0) {
    await sql`update document_page set page_no = page_no + 100000 where document_id = ${documentId}`;
    for (const [index, row] of rows.entries()) {
      await sql`update document_page set page_no = ${index + 1} where id = ${row['id'] as string}`;
    }
  }
  await sql`update document set page_count = ${rows.length} where id = ${documentId}`;
  return rows.length;
}

let movesReplayed = 0;
for (let groupStart = 0; groupStart < pageMoves.length;) {
  const operationId = pageMoves[groupStart]!.sidecar.client_operation_id;
  let groupEnd = groupStart + 1;
  while (groupEnd < pageMoves.length
      && pageMoves[groupEnd]!.sidecar.client_operation_id === operationId) groupEnd += 1;
  const affected = new Map<string, string>();
  for (const { key, sidecar: move } of pageMoves.slice(groupStart, groupEnd)) {
    const source = (await sql`select id from document where short_id = ${move.from_doc_short_id}`)[0];
    const target = (await sql`select id from document where short_id = ${move.to_doc_short_id}`)[0];
    if (!source || !target) {
      reconciliation.push(
        `page_move 文档骨架缺失: ${move.from_doc_short_id} -> ${move.to_doc_short_id} (${key})`,
      );
      continue;
    }
    const sourceId = source['id'] as string;
    const targetId = target['id'] as string;
    affected.set(sourceId, move.corrected_at);
    affected.set(targetId, move.corrected_at);
    let candidates = await sql`
      select id, page_no from document_page
      where document_id = ${sourceId} and content_sha256 = ${move.page_sha256}
        and page_no = ${move.from_page_no}
    `;
    if (candidates.length === 0) {
      candidates = await sql`
        select id, page_no from document_page
        where document_id = ${sourceId} and content_sha256 = ${move.page_sha256}
        order by page_no
      `;
    }
    if (candidates.length === 0) {
      const alreadyMoved = await sql`
        select id from document_page
        where document_id = ${targetId} and content_sha256 = ${move.page_sha256}
          and page_no = ${move.to_page_no}
      `;
      if (alreadyMoved.length > 0) continue;
      reconciliation.push(`page_move 找不到源页: ${move.page_sha256} (${key})`);
      continue;
    }
    if (candidates.length > 1) {
      reconciliation.push(`page_move 摘要在源文档内不唯一: ${move.page_sha256} (${key})`);
      continue;
    }
    await sql`
      update document_page set document_id = ${targetId}, page_no = ${move.to_page_no}
      where id = ${candidates[0]!['id'] as string}
    `;
    movesReplayed += 1;
  }
  // 同一次 split/merge 的所有页移动完成后再重排。若逐页重排，重复内容页的
  // from_page_no 会在操作中途变化，重建可能交换 capture_order 不同的两页。
  for (const [documentId, correctedAt] of affected) {
    const count = await normalizeRebuiltPages(documentId);
    if (count === 0) {
      await sql`
        update document set archived_at = coalesce(archived_at, ${correctedAt})
        where id = ${documentId}
      `;
    }
  }
  groupStart = groupEnd;
}
console.log(`page moves replayed: ${movesReplayed}`);

// Observation journal 冻结的是不可变 origin identity；当前 document/page 只是
// 导航投影。page_move 在 journal 之后回放，因此必须在页面边界更正完成后统一重算。
await sql`
  update observation
  set current_document_id = null, current_page_no = null
  where origin_capture_document_id is not null
`;
await sql`
  update observation o
  set current_document_id = dp.document_id, current_page_no = dp.page_no
  from document_page dp, document d
  where d.id = dp.document_id and d.person_id = o.person_id
    and dp.origin_capture_document_id = o.origin_capture_document_id
    and dp.origin_capture_order = o.origin_capture_order
    and dp.origin_object_sha256 = o.object_sha256
`;
for (const table of ['medication', 'timeline_event'] as const) {
  await sql.unsafe(`
    update ${table}
    set current_document_id = null, current_page_no = null
    where origin_capture_document_id is not null
  `);
  await sql.unsafe(`
    update ${table} fact
    set current_document_id = dp.document_id, current_page_no = dp.page_no
    from document_page dp, document d
    where d.id = dp.document_id and d.person_id = fact.person_id
      and dp.origin_capture_document_id = fact.origin_capture_document_id
      and dp.origin_capture_order = fact.origin_capture_order
      and dp.origin_object_sha256 = fact.object_sha256
  `);
}

// derived observation 是可删除 L2：不读 journal，只从已恢复的 L1 输入重算。
await sql`delete from observation where is_derived = true`;
let derivedRestored = 0;
const derivationPeople = await sql`
  select id, birth_date::text, sex_at_birth from person order by id
`;
for (const profile of derivationPeople) {
  const personId = profile['id'] as string;
  const rows = await sql`
    select id, revision, document_id, encounter_id, observed_on::text, observed_at,
           time_precision, date_source, concept_code, value_num, value_si, unit_ucum, unit_si,
           qualifier, body_site, specimen, specimen_label, method, device, measurement_setting,
           extra_dims, result_kind, collected_at, reported_at, lab_facility_id
    from observation
    where person_id = ${personId} and is_derived = false and archived_at is null
      and concept_code is not null
    order by id
  `;
  const facts: DerivationInputFact[] = rows.map((row) => ({
    id: row['id'] as string, revision: row['revision'] as number,
    document_id: row['document_id'] as string | null,
    encounter_id: row['encounter_id'] as string | null,
    observed_on: row['observed_on'] as string,
    observed_at: row['observed_at'] instanceof Date ? row['observed_at'].toISOString() : null,
    time_precision: row['time_precision'] as DerivationInputFact['time_precision'],
    date_source: row['date_source'] as DerivationInputFact['date_source'],
    concept_code: row['concept_code'] as string,
    value_num: row['value_num'] === null ? null : Number(row['value_num']),
    value_si: row['value_si'] === null ? null : Number(row['value_si']),
    unit_ucum: row['unit_ucum'] as string | null, unit_si: row['unit_si'] as string | null,
    qualifier: row['qualifier'] as string | null, body_site: row['body_site'] as string | null,
    specimen: row['specimen'] as string | null,
    specimen_label: row['specimen_label'] as string | null,
    method: row['method'] as string | null, device: row['device'] as string | null,
    measurement_setting: row['measurement_setting'] as string | null,
    extra_dims: row['extra_dims'] as Record<string, string> | null,
    result_kind: row['result_kind'] as DerivationInputFact['result_kind'],
    collected_at: row['collected_at'] instanceof Date ? row['collected_at'].toISOString() : null,
    reported_at: row['reported_at'] instanceof Date ? row['reported_at'].toISOString() : null,
    lab_facility_id: row['lab_facility_id'] as string | null,
  }));
  const plans = deriveObservationPlans({
    person: {
      birth_date: profile['birth_date'] as string | null,
      sex_at_birth: profile['sex_at_birth'] as 'male' | 'female' | 'unknown',
    },
    facts,
  });
  const now = new Date();
  for (const item of plans) {
    const basis = item.basis;
    const concept = conceptByCode(item.concept_code)!;
    const mappingFingerprint = createHash('sha256').update(canonicalJsonString({
      local_name: item.local_name.normalize('NFKC').trim().toLocaleLowerCase('zh-CN'),
      specimen: basis.specimen, method: basis.method,
    })).digest('hex');
    await sql`
      insert into observation
        (id, person_id, document_id, encounter_id, observed_on, observed_at, time_precision,
         date_source, local_name, mapping_fingerprint, concept_code, concept_catalog_version,
         loinc_code, qualifier, body_site, extra_dims, series_key,
         value_raw, value_num, comparator, unit_raw, unit_ucum, value_si, unit_si,
         conversion_version, specimen, specimen_label, method, device, measurement_setting,
         result_kind, collected_at, reported_at, lab_facility_id, source, review_status,
         reviewed_at, consistency_flags, is_derived, derived_formula, calculation_version,
         derivation_key, input_observation_ids, input_revision_hash, revision, created_at, updated_at)
      values
        (${item.id}, ${personId}, ${basis.document_id}, ${basis.encounter_id},
         ${basis.observed_on}, ${basis.observed_at}, ${basis.time_precision}, ${basis.date_source},
         ${item.local_name}, ${mappingFingerprint}, ${item.concept_code},
         ${CONCEPT_CATALOG_VERSION}, ${concept.loinc_code}, ${basis.qualifier}, ${basis.body_site},
         ${sql.json(basis.extra_dims as postgres.JSONValue)}, ${item.series_key}, ${String(item.value)},
         ${item.value}, '=', ${item.unit}, ${item.unit}, ${item.value}, ${item.unit},
         'derived-canonical@1', ${basis.specimen}, ${basis.specimen_label}, ${basis.method},
         ${basis.device}, ${basis.measurement_setting}, 'calculated', ${basis.collected_at},
         ${basis.reported_at}, ${basis.lab_facility_id}, 'derived', 'confirmed', ${now},
         ${[]}, true, ${item.formula}, ${item.calculation_version}, ${item.derivation_key},
         ${item.input_observation_ids}, ${item.input_revision_hash}, 1, ${now}, ${now})
    `;
    derivedRestored += 1;
  }
}
console.log(`derived observations rebuilt: ${derivedRestored}`);

// ── 6. 从当前 L1 投影确定性重建 core keyword index ──
// search_entry 是可删除 L2；这里不读取 extraction/OCR/embedding，也不把旧 AI 列晋升为事实。
await sql`delete from search_entry`;
const searchDocuments = await sql`
  select d.id, d.person_id, d.encounter_id, d.original_filename, d.capture_date::text,
         d.captured_at, dmm.doc_type, dmm.sampled_on::text, dmm.reported_on::text,
         dmm.facility_name_raw, dmm.department, dmm.title, dmm.note,
         dmm.field_provenance, f.name as facility_name, e.occurred_on::text as encounter_on
  from document d
  left join document_manual_metadata dmm on dmm.document_id = d.id
  left join facility f on f.id = dmm.facility_id
  left join encounter e on e.id = d.encounter_id and e.archived_at is null
  where d.archived_at is null
  order by d.id
`;
for (const row of searchDocuments) {
  const provenance = (row['field_provenance'] ?? {}) as Record<string, unknown>;
  const has = (field: string) => Object.prototype.hasOwnProperty.call(provenance, field);
  const title = has('title') ? row['title'] as string | null : row['original_filename'] as string | null;
  const facilityName = has('facility_id')
    ? row['facility_name'] as string | null
    : has('facility_name_raw') ? row['facility_name_raw'] as string | null : null;
  const occurredOn = (has('sampled_on') ? row['sampled_on'] : null)
    ?? (has('reported_on') ? row['reported_on'] : null)
    ?? row['encounter_on']
    ?? row['capture_date'];
  const body = [
    row['original_filename'], title,
    has('doc_type') ? row['doc_type'] : null,
    facilityName,
    has('department') ? row['department'] : null,
    has('note') ? row['note'] : null,
  ].filter(Boolean).join('\n');
  const sourceRevisionHash = createHash('sha256').update(canonicalJsonString({
    id: row['id'], occurred_on: occurredOn, title, body, provenance,
  })).digest('hex');
  await sql`
    insert into search_entry
      (id, person_id, entity_type, entity_id, document_id, occurred_on, sort_at,
       title, core_body, source_revision_hash)
    values
      (${row['id'] as string}, ${row['person_id'] as string}, 'document', ${row['id'] as string},
       ${row['id'] as string}, ${occurredOn as string}, ${row['captured_at'] as Date},
       ${title ?? '医疗记录'}, ${body}, ${sourceRevisionHash})
  `;
}
const searchEncounters = await sql`
  select id, person_id, encounter_type, department, occurred_on::text, occurred_at,
         chief_complaint, diagnosis_text, doctor_advice, revision
  from encounter where archived_at is null order by id
`;
for (const row of searchEncounters) {
  const title = (row['department'] as string | null)
    ?? (row['chief_complaint'] as string | null)
    ?? `${row['occurred_on'] as string} 就诊`;
  const body = [
    row['encounter_type'], row['department'], row['chief_complaint'],
    row['diagnosis_text'], row['doctor_advice'],
  ].filter(Boolean).join('\n');
  const sourceRevisionHash = createHash('sha256').update(canonicalJsonString({
    id: row['id'], revision: row['revision'], title, body,
  })).digest('hex');
  await sql`
    insert into search_entry
      (id, person_id, entity_type, entity_id, occurred_on, sort_at,
       title, core_body, source_revision_hash)
    values
      (${row['id'] as string}, ${row['person_id'] as string}, 'encounter', ${row['id'] as string},
       ${row['occurred_on'] as string}, ${row['occurred_at'] as Date | null
          ?? new Date(`${row['occurred_on'] as string}T00:00:00.000Z`)},
       ${title}, ${body}, ${sourceRevisionHash})
  `;
}
const searchContextAnswers = await sql`
  select ca.id, ca.session_id, ca.question_text, ca.question_snapshot, ca.answer_type,
         ca.value, ca.answered_at, ca.event_on::text, ca.event_at, ca.revision,
         cs.person_id, cs.document_id, cs.created_at as session_created_at
  from context_answer ca
  inner join context_session cs on cs.id = ca.session_id
  where ca.skipped = false and ca.upload_id is null
  order by ca.id
`;
let contextSearchEntries = 0;
for (const row of searchContextAnswers) {
  const question = row['question_snapshot'] as {
    options?: Array<{ value: string; label: string }>;
  };
  let body = '';
  if (row['answer_type'] === 'choice' && typeof row['value'] === 'string') {
    body = question.options?.find((option) => option.value === row['value'])?.label
      ?? row['value'] as string;
  } else if (row['answer_type'] === 'multi_choice' && Array.isArray(row['value'])) {
    const labels = new Map((question.options ?? []).map((option) => [option.value, option.label]));
    body = (row['value'] as unknown[]).map((value) => labels.get(String(value)) ?? String(value)).join(' ');
  } else if (typeof row['value'] === 'string' || typeof row['value'] === 'number') {
    body = String(row['value']);
  }
  if (!body.trim()) continue;
  const occurredOn = row['event_on'] as string | null;
  const sortAt = row['event_at'] as Date | null
    ?? (occurredOn ? new Date(`${occurredOn}T00:00:00.000Z`) : null)
    ?? row['answered_at'] as Date | null
    ?? row['session_created_at'] as Date;
  const sourceRevisionHash = createHash('sha256').update(canonicalJsonString({
    id: row['id'], revision: row['revision'], document_id: row['document_id'],
    occurred_on: occurredOn, title: row['question_text'], body,
  })).digest('hex');
  await sql`
    insert into search_entry
      (id, person_id, entity_type, entity_id, document_id, occurred_on, sort_at,
       title, core_body, source_revision_hash)
    values
      (${row['id'] as string}, ${row['person_id'] as string}, 'context_answer',
       ${row['id'] as string}, ${row['document_id'] as string | null}, ${occurredOn}, ${sortAt},
       ${row['question_text'] as string}, ${body}, ${sourceRevisionHash})
  `;
  contextSearchEntries += 1;
}
const searchObservations = await sql`
  select id, person_id, document_id, observed_on::text, observed_at, local_name, concept_code,
         value_raw, unit_raw, ref_text, specimen, specimen_label, method, device, revision
  from observation where archived_at is null order by id
`;
for (const row of searchObservations) {
  const title = row['local_name'] as string;
  const body = [
    row['concept_code'], row['value_raw'], row['unit_raw'], row['ref_text'],
    row['specimen'], row['specimen_label'], row['method'], row['device'],
  ].filter(Boolean).join('\n');
  const occurredOn = row['observed_on'] as string;
  const sourceRevisionHash = createHash('sha256').update(canonicalJsonString({
    id: row['id'], revision: row['revision'], title, body, occurred_on: occurredOn,
  })).digest('hex');
  await sql`
    insert into search_entry
      (id, person_id, entity_type, entity_id, document_id, occurred_on, sort_at,
       title, core_body, source_revision_hash)
    values
      (${row['id'] as string}, ${row['person_id'] as string}, 'observation',
       ${row['id'] as string}, ${row['document_id'] as string | null}, ${occurredOn},
       ${row['observed_at'] as Date | null ?? new Date(`${occurredOn}T00:00:00.000Z`)},
       ${title}, ${body}, ${sourceRevisionHash})
  `;
}
const searchMedications = await sql`
  select id, person_id, current_document_id, kind, name_raw, generic_name, dose_raw,
         dose_value, dose_unit, frequency_raw, route, administration_group, note,
         administered_at, started_on::text, revision
  from medication where archived_at is null order by id
`;
for (const row of searchMedications) {
  const occurredOn = row['administered_at'] instanceof Date
    ? row['administered_at'].toISOString().slice(0, 10)
    : row['started_on'] as string;
  const body = [
    row['generic_name'], row['dose_raw'],
    row['dose_value'] === null ? null : `${Number(row['dose_value'])} ${row['dose_unit'] ?? ''}`.trim(),
    row['frequency_raw'], row['route'], row['administration_group'], row['note'],
  ].filter(Boolean).join('\n');
  const sourceRevisionHash = createHash('sha256').update(canonicalJsonString({
    id: row['id'], revision: row['revision'], title: row['name_raw'], body,
    occurred_on: occurredOn,
  })).digest('hex');
  await sql`
    insert into search_entry
      (id, person_id, entity_type, entity_id, document_id, occurred_on, sort_at,
       title, core_body, source_revision_hash)
    values
      (${row['id'] as string}, ${row['person_id'] as string}, 'medication',
       ${row['id'] as string}, ${row['current_document_id'] as string | null}, ${occurredOn},
       ${row['administered_at'] as Date | null ?? new Date(`${occurredOn}T00:00:00.000Z`)},
       ${row['name_raw'] as string}, ${body}, ${sourceRevisionHash})
  `;
}
const searchTimelineEvents = await sql`
  select id, person_id, current_document_id, kind, title, note, occurred_on::text,
         occurred_at, revision
  from timeline_event where archived_at is null order by id
`;
for (const row of searchTimelineEvents) {
  const occurredOn = row['occurred_on'] as string | null;
  const body = [row['kind'], row['note']].filter(Boolean).join('\n');
  const sourceRevisionHash = createHash('sha256').update(canonicalJsonString({
    id: row['id'], revision: row['revision'], title: row['title'], body,
    occurred_on: occurredOn,
  })).digest('hex');
  await sql`
    insert into search_entry
      (id, person_id, entity_type, entity_id, document_id, occurred_on, sort_at,
       title, core_body, source_revision_hash)
    values
      (${row['id'] as string}, ${row['person_id'] as string}, 'timeline_event',
       ${row['id'] as string}, ${row['current_document_id'] as string | null}, ${occurredOn},
       ${row['occurred_at'] as Date | null
          ?? (occurredOn ? new Date(`${occurredOn}T00:00:00.000Z`) : null)},
       ${row['title'] as string}, ${body}, ${sourceRevisionHash})
  `;
}
console.log(`search entries rebuilt: ${
  searchDocuments.length + searchEncounters.length + contextSearchEntries + searchObservations.length
    + searchMedications.length + searchTimelineEvents.length
}`);

if (reconciliation.length) {
  console.log('对账报告(需人工处置,不入库):');
  for (const r of reconciliation) console.log('  - ' + r);
}
console.log(JSON.stringify({
  persons: personKeys.length, documents: docsRestored, human_events: humanEventsReplayed,
  page_moves: movesReplayed, reconciliation,
}));
await sql.end();
