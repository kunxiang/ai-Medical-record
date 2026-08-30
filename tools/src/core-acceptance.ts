import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import postgres from 'postgres';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { adminClient, BUCKET } from './s3-admin.js';

const API = process.env.API_URL ?? 'http://localhost:8300';
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const EMAIL = process.env.SEED_EMAIL ?? 'owner@local.test';
const PASSWORD = process.env.SEED_PASSWORD ?? 'core-acceptance-password';

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function request(
  method: string,
  path: string,
  input: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any; text: string }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON response */ }
  return { status: response.status, json, text };
}

async function waitForExport(
  id: string,
  token: string,
  timeoutMs = 90_000,
): Promise<Awaited<ReturnType<typeof request>>> {
  const deadline = Date.now() + timeoutMs;
  let latest = await request('GET', `/api/v1/exports/${id}`, { token });
  while (Date.now() < deadline && latest.status === 200
    && latest.json?.state !== 'done' && latest.json?.state !== 'failed') {
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await request('GET', `/api/v1/exports/${id}`, { token });
  }
  return latest;
}

async function downloadExport(id: string, token: string): Promise<{
  response: Response; bytes: Buffer; sha256: string;
}> {
  const response = await fetch(`${API}/api/v1/exports/${id}/download`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { response, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function ageOn(birthDate: string, localDate: string): number {
  const [birthYear, birthMonth, birthDay] = birthDate.split('-').map(Number);
  const [year, month, day] = localDate.split('-').map(Number);
  let age = year! - birthYear!;
  if (month! < birthMonth! || (month === birthMonth && day! < birthDay!)) age -= 1;
  return age;
}

function localDateAt(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields['year']}-${fields['month']}-${fields['day']}`;
}

function resolvedQuestions(
  template: any,
  stage: 'onsite' | 'same_day' | 'anytime',
  profile: { sex_at_birth: string; age: number },
): any[] {
  const conditional = (template.conditional ?? []).filter((item: any) => {
    if (item.append_to !== stage) return false;
    if (item.when.sex_at_birth !== undefined && item.when.sex_at_birth !== profile.sex_at_birth) return false;
    const range = item.when.age_between;
    return range === undefined || (profile.age >= range[0] && profile.age <= range[1]);
  });
  return [
    ...(template.stages?.[stage]?.questions ?? []),
    ...conditional.flatMap((item: any) => item.questions),
  ];
}

function silentWav(): Buffer {
  const sampleCount = 800;
  const body = Buffer.alloc(sampleCount * 2);
  const wav = Buffer.alloc(44 + body.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8_000, 24); wav.writeUInt32LE(16_000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(body.length, 40); body.copy(wav, 44);
  return wav;
}

async function uploadContextMedia(input: {
  token: string; personId: string; sessionId: string; questionKey: string;
  kind: 'audio' | 'photo'; mime: string; bytes: Buffer;
  prepareOperationId: string; finalizeOperationId: string;
}): Promise<{
  prepare: Awaited<ReturnType<typeof request>>;
  presign: Awaited<ReturnType<typeof request>>;
  put: Response;
  finalize: Awaited<ReturnType<typeof request>>;
}> {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const prepare = await request('POST', '/api/v1/context/uploads/prepare', {
    token: input.token,
    body: {
      client_operation_id: input.prepareOperationId,
      person_id: input.personId,
      session_id: input.sessionId,
      question_key: input.questionKey,
      kind: input.kind,
      mime: input.mime,
      byte_size: input.bytes.length,
      sha256,
    },
  });
  const presign = await request(
    'POST', `/api/v1/context/uploads/${prepare.json?.id}/presign`, { token: input.token },
  );
  const put = await fetch(presign.json?.url, {
    method: 'PUT', headers: presign.json?.headers, body: input.bytes,
  });
  const finalize = await request(
    'POST', `/api/v1/context/uploads/${prepare.json?.id}/finalize`, {
      token: input.token,
      body: { client_operation_id: input.finalizeOperationId, parts: [] },
    },
  );
  return { prepare, presign, put, finalize };
}

const web = await fetch(WEB);
check('C0-1 Web 可访问', web.ok, `status=${web.status}`);

const login = await request('POST', '/api/v1/auth/login', {
  body: { email: EMAIL, password: PASSWORD },
});
check('C0-1 Core API 可登录', login.status === 200 && typeof login.json?.access_token === 'string', login.text);
const token = login.json?.access_token as string;

const capabilities = await request('GET', '/api/v1/capabilities', { token });
check(
  'C0-4 off 能力发现 fail closed',
  capabilities.status === 200
    && capabilities.json?.processing_mode === 'off'
    && capabilities.json?.assist?.available === false
    && capabilities.json?.assist?.plugins?.length === 0
    && capabilities.json?.assist?.capabilities?.length === 0,
  capabilities.text,
);

const person = await request('POST', '/api/v1/people', {
  token,
  body: {
    display_name: 'Core 验收成员', birth_date: '1990-01-01', sex_at_birth: 'female',
    relation_to_owner: 'other', allergies: [],
  },
});
check('C0-2 off 可创建家庭档案', person.status === 201, person.text);

const templateManifest = await request('GET', '/api/v1/context/templates', { token });
const labTemplateResponse = await request(
  'GET', '/api/v1/context/templates/lab-report/versions/1', { token },
);
const labTemplate = labTemplateResponse.json;
const profileDate = localDateAt(new Date().toISOString(), 'Asia/Shanghai');
const profile = {
  sex_at_birth: 'female',
  age: ageOn('1990-01-01', profileDate),
};
const labOnsiteQuestions = resolvedQuestions(labTemplate, 'onsite', profile);
check(
  'P1-3 模板 manifest/hash 与女性条件题 snapshot 可离线冻结',
  templateManifest.status === 200
    && templateManifest.json?.templates?.some((item: any) => (
      item.template_id === 'lab-report'
      && item.versions?.[0]?.hash === labTemplate?.template_hash
    ))
    && labTemplateResponse.status === 200
    && labOnsiteQuestions.length === 6
    && labOnsiteQuestions.at(-1)?.key === 'menstrual_phase',
  `${templateManifest.text} / ${labTemplateResponse.text}`,
);

const documentContextSessionId = '018f0000-0000-7000-8000-000000000201';
const documentContextCreateBody = {
  client_operation_id: '018f0000-0000-7000-8000-000000000202',
  id: documentContextSessionId,
  person_id: person.json.id,
  scope_type: 'document',
  scope_key: 'core-off-document-0001',
  client_document_id: 'core-off-document-0001',
  document_id: null,
  encounter_id: null,
  template_id: 'lab-report',
  template_version: 1,
  template_hash: labTemplate?.template_hash,
  question_snapshot: labOnsiteQuestions,
  stage: 'onsite',
};
const documentContextCreate = await request('POST', '/api/v1/context/sessions', {
  token, body: documentContextCreateBody,
});
const documentContextReplay = await request('POST', '/api/v1/context/sessions', {
  token, body: documentContextCreateBody,
});
const documentContextConflict = await request('POST', '/api/v1/context/sessions', {
  token,
  body: { ...documentContextCreateBody, id: '018f0000-0000-7000-8000-000000000203' },
});
const wrongConditionalSnapshot = await request('POST', '/api/v1/context/sessions', {
  token,
  body: {
    ...documentContextCreateBody,
    client_operation_id: '018f0000-0000-7000-8000-000000000204',
    id: '018f0000-0000-7000-8000-000000000205',
    scope_type: 'standalone', scope_key: '018f0000-0000-7000-8000-000000000205',
    client_document_id: null,
    question_snapshot: labTemplate?.stages?.onsite?.questions ?? [],
  },
});
check(
  'P1-1/P1-3 文档未上传时 session 可建、幂等且拒绝条件题漂移',
  documentContextCreate.status === 201
    && documentContextCreate.json?.session?.document_id === null
    && documentContextReplay.status === 201
    && documentContextReplay.json?.session?.id === documentContextSessionId
    && documentContextConflict.status === 409
    && documentContextConflict.json?.error?.code === 'operation_conflict'
    && wrongConditionalSnapshot.status === 400
    && wrongConditionalSnapshot.json?.error?.code === 'validation_failed',
  `${documentContextCreate.text} / ${documentContextReplay.text} / ${documentContextConflict.text} / ${wrongConditionalSnapshot.text}`,
);

const bytes = await sharp({
  create: { width: 48, height: 64, channels: 3, background: { r: 232, g: 248, b: 245 } },
}).jpeg({ quality: 88 }).toBuffer();
const sha256 = createHash('sha256').update(bytes).digest('hex');
const presign = await request('POST', '/api/v1/uploads/presign', {
  token,
  body: {
    person_id: person.json.id,
    files: [{ filename: 'core-off.jpg', mime_type: 'image/jpeg', byte_size: bytes.length, sha256 }],
  },
});
check('C0-2 off 可准备上传', presign.status === 200, presign.text);
const upload = presign.json?.uploads?.[0];
const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
check('C0-2 off 可上传原件', put.ok, `status=${put.status}`);
const created = await request('POST', '/api/v1/documents', {
  token,
  body: {
    person_id: person.json.id,
    person_confirmed: true,
    batch_id: presign.json.batch_id,
    source: 'album',
    captured_at: '2026-08-28T12:00:00+08:00',
    pages: [{
      upload_id: upload.upload_id, page_no: 1, width: 1200, height: 1600, sha256,
    }],
    client_document_id: 'core-off-document-0001',
  },
});
check('C0-2 off 文档登记为 ready', created.status === 201 && created.json?.status === 'ready', created.text);

const documentContextBindBody = {
  client_operation_id: '018f0000-0000-7000-8000-000000000206', if_revision: 1,
};
const documentContextBind = await request(
  'POST', `/api/v1/context/sessions/${documentContextSessionId}/bind-document`, {
    token, body: documentContextBindBody,
  },
);
const documentContextBindReplay = await request(
  'POST', `/api/v1/context/sessions/${documentContextSessionId}/bind-document`, {
    token, body: documentContextBindBody,
  },
);
check(
  'P1-1 client_document_id 在登记后幂等绑定真实 document',
  documentContextBind.status === 200
    && documentContextBind.json?.session?.document_id === created.json.id
    && documentContextBind.json?.session?.revision === 2
    && documentContextBindReplay.status === 200
    && documentContextBindReplay.json?.session?.document_id === created.json.id,
  `${documentContextBind.text} / ${documentContextBindReplay.text}`,
);

const labAnswerBody = {
  client_operation_id: '018f0000-0000-7000-8000-000000000207',
  if_revision: 2,
  answers: [
    { question_key: 'fasting_status', answer_type: 'choice', value: 'fasting', skipped: false },
    { question_key: 'collection_time', answer_type: 'datetime', value: '2026-08-28T03:30:00.000Z', skipped: false },
    { question_key: 'visit_reason', answer_type: 'text', value: '人工记录的复查原因', skipped: false },
    { question_key: 'current_symptoms', answer_type: 'audio', value: null, skipped: true },
    { question_key: 'recent_illness', answer_type: 'multi_choice', value: ['infection', 'intense_exercise'], skipped: false },
    { question_key: 'menstrual_phase', answer_type: 'choice', value: 'follicular', skipped: false },
  ],
};
const labAnswers = await request(
  'POST', `/api/v1/context/sessions/${documentContextSessionId}/answers`, {
    token, body: labAnswerBody,
  },
);
const labAnswersReplay = await request(
  'POST', `/api/v1/context/sessions/${documentContextSessionId}/answers`, {
    token, body: labAnswerBody,
  },
);
const labAnswersConflict = await request(
  'POST', `/api/v1/context/sessions/${documentContextSessionId}/answers`, {
    token,
    body: {
      ...labAnswerBody,
      answers: labAnswerBody.answers.map((answer) => answer.question_key === 'visit_reason'
        ? { ...answer, value: '相同 operation 的不同载荷' } : answer),
    },
  },
);
const labAnswersStale = await request(
  'POST', `/api/v1/context/sessions/${documentContextSessionId}/answers`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000208',
      if_revision: 2,
      answers: [{ question_key: 'visit_reason', answer_type: 'text', value: '过期草稿', skipped: false }],
    },
  },
);
check(
  'P1-4 回答 batch 支持条件题、跳过、文字替代并保持 revision/operation 语义',
  labAnswers.status === 200
    && labAnswers.json?.session?.revision === 3
    && labAnswers.json?.answers?.length === 6
    && labAnswers.json?.answers?.some((answer: any) => answer.question_key === 'current_symptoms' && answer.skipped)
    && labAnswersReplay.status === 200
    && labAnswersReplay.json?.session?.revision === 3
    && labAnswersConflict.status === 409
    && labAnswersConflict.json?.error?.code === 'operation_conflict'
    && labAnswersStale.status === 409
    && labAnswersStale.json?.error?.code === 'revision_conflict',
  `${labAnswers.text} / ${labAnswersReplay.text} / ${labAnswersConflict.text} / ${labAnswersStale.text}`,
);
const documentContextComplete = await request(
  'POST', `/api/v1/context/sessions/${documentContextSessionId}/complete`, {
    token,
    body: { client_operation_id: '018f0000-0000-7000-8000-000000000209', if_revision: 3 },
  },
);
check(
  'P1-9 文档情境完成后保持冻结 snapshot 与绑定',
  documentContextComplete.status === 200
    && documentContextComplete.json?.session?.status === 'completed'
    && documentContextComplete.json?.session?.revision === 4
    && documentContextComplete.json?.session?.document_id === created.json.id,
  documentContextComplete.text,
);

const metadataOperation = '018f0000-0000-7000-8000-000000000101';
const metadataBody = {
  client_operation_id: metadataOperation,
  if_revision: 0,
  doc_type: 'lab_report',
  sampled_on: '2026-08-27',
  title: 'Core 人工血脂记录',
  note: '由人工录入，不依赖智能处理',
};
const metadata = await request('PATCH', `/api/v1/documents/${created.json.id}/metadata`, {
  token, body: metadataBody,
});
check(
  'P0-1 人工 metadata 写入逐字段 provenance',
  metadata.status === 200
    && metadata.json?.revision === 1
    && metadata.json?.effective_metadata?.title?.value === 'Core 人工血脂记录'
    && metadata.json?.effective_metadata?.title?.source === 'manual',
  metadata.text,
);
const metadataReplay = await request('PATCH', `/api/v1/documents/${created.json.id}/metadata`, {
  token, body: metadataBody,
});
check(
  'P0-2 同 operation 同请求返回首次安全响应',
  metadataReplay.status === 200
    && metadataReplay.json?.document_id === metadata.json?.document_id
    && metadataReplay.json?.revision === metadata.json?.revision
    && metadataReplay.json?.effective_metadata?.title?.value
      === metadata.json?.effective_metadata?.title?.value
    && metadataReplay.json?.field_provenance?.title?.event_id === metadataOperation,
  metadataReplay.text,
);
const operationConflict = await request('PATCH', `/api/v1/documents/${created.json.id}/metadata`, {
  token, body: { ...metadataBody, title: '不同载荷' },
});
check(
  'P0-2 同 operation 异请求返回 409',
  operationConflict.status === 409 && operationConflict.json?.error?.code === 'operation_conflict',
  operationConflict.text,
);
const revisionConflict = await request('PATCH', `/api/v1/documents/${created.json.id}/metadata`, {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000102',
    if_revision: 0,
    title: '过期草稿',
  },
});
check(
  'P0-2 stale revision 返回 base/current/draft',
  revisionConflict.status === 409
    && revisionConflict.json?.error?.code === 'revision_conflict'
    && revisionConflict.json?.error?.details?.current?.revision === 1,
  revisionConflict.text,
);
const documents = await request(
  'GET', `/api/v1/documents?person_id=${person.json.id}&date_field=sampled`, { token },
);
check(
  'P0-3 五日期列表读取 manual-first effective metadata',
  documents.status === 200
    && documents.json?.documents?.[0]?.dates?.selected_date === '2026-08-27'
    && documents.json?.documents?.[0]?.effective_metadata?.doc_type?.value === 'lab_report',
  documents.text,
);

const encounterCreate = await request('POST', `/api/v1/people/${person.json.id}/encounters`, {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000111',
    encounter_type: 'outpatient', occurred_on: '2026-08-27',
    department: '检验科', chief_complaint: '复查血脂',
  },
});
check(
  'P0-4 手工创建 encounter',
  encounterCreate.status === 201 && encounterCreate.json?.revision === 1,
  encounterCreate.text,
);
const encounterReplay = await request('POST', `/api/v1/people/${person.json.id}/encounters`, {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000111',
    encounter_type: 'outpatient', occurred_on: '2026-08-27',
    department: '检验科', chief_complaint: '复查血脂',
  },
});
check(
  'P0-4 encounter 创建可幂等重放',
  encounterReplay.status === 201 && encounterReplay.json?.id === encounterCreate.json?.id,
  encounterReplay.text,
);
const encounterOperationConflict = await request(
  'POST', `/api/v1/people/${person.json.id}/encounters`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000111',
      encounter_type: 'outpatient', occurred_on: '2026-08-27', department: '不同科室',
    },
  },
);
check(
  'P0-4 encounter 同 operation 异请求返回 409',
  encounterOperationConflict.status === 409
    && encounterOperationConflict.json?.error?.code === 'operation_conflict',
  encounterOperationConflict.text,
);
const encounterLink = await request(
  'POST', `/api/v1/encounters/${encounterCreate.json.id}/documents`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000112',
      if_revision: 1,
      document_ids: [created.json.id],
    },
  },
);
check(
  'P0-4 encounter 原子关联同人文档',
  encounterLink.status === 200
    && encounterLink.json?.encounter?.revision === 2
    && encounterLink.json?.document_ids?.[0] === created.json.id,
  encounterLink.text,
);
const encounterStale = await request('PATCH', `/api/v1/encounters/${encounterCreate.json.id}`, {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000113',
    if_revision: 1, doctor_advice: '过期编辑',
  },
});
check(
  'P0-4 encounter stale revision 返回冲突详情',
  encounterStale.status === 409
    && encounterStale.json?.error?.code === 'revision_conflict'
    && encounterStale.json?.error?.details?.current?.revision === 2,
  encounterStale.text,
);
const encounterUpdate = await request('PATCH', `/api/v1/encounters/${encounterCreate.json.id}`, {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000131',
    if_revision: 2,
    doctor_advice: '人工确认的复查医嘱',
  },
});
const encounterArchive = await request('PATCH', `/api/v1/encounters/${encounterCreate.json.id}`, {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000132',
    if_revision: 3,
    archived: true,
  },
});
const archivedEncounterSearch = await request(
  'GET', `/api/v1/search?person_id=${person.json.id}&q=${encodeURIComponent('复查血脂')}`,
  { token },
);
const encounterRestore = await request('PATCH', `/api/v1/encounters/${encounterCreate.json.id}`, {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000133',
    if_revision: 4,
    archived: false,
  },
});
check(
  'P0-4 encounter 更新、归档、恢复与检索投影一致',
  encounterUpdate.status === 200
    && encounterUpdate.json?.revision === 3
    && encounterUpdate.json?.doctor_advice === '人工确认的复查医嘱'
    && encounterArchive.status === 200
    && encounterArchive.json?.revision === 4
    && typeof encounterArchive.json?.archived_at === 'string'
    && archivedEncounterSearch.status === 200
    && archivedEncounterSearch.json?.results?.length === 0
    && encounterRestore.status === 200
    && encounterRestore.json?.revision === 5
    && encounterRestore.json?.archived_at === null,
  `${encounterUpdate.text} / ${encounterArchive.text} / ${archivedEncounterSearch.text} / ${encounterRestore.text}`,
);
const otherPerson = await request('POST', '/api/v1/people', {
  token,
  body: {
    display_name: 'Core 验收其他成员', birth_date: '1992-02-02', sex_at_birth: 'unknown',
    relation_to_owner: 'other', allergies: [],
  },
});
const otherEncounter = await request('POST', `/api/v1/people/${otherPerson.json.id}/encounters`, {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000114',
    encounter_type: 'other', occurred_on: '2026-08-26',
  },
});
const crossPersonLink = await request(
  'POST', `/api/v1/encounters/${otherEncounter.json.id}/documents`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000115',
      if_revision: 1, document_ids: [created.json.id],
    },
  },
);
check(
  'P0-4 encounter 拒绝跨 person 文档且不泄漏',
  crossPersonLink.status === 404 && crossPersonLink.json?.error?.code === 'not_found',
  crossPersonLink.text,
);
const encounterList = await request(
  'GET', `/api/v1/people/${person.json.id}/encounters`, { token },
);
check(
  'P0-4 encounter 列表稳定返回',
  encounterList.status === 200 && encounterList.json?.encounters?.[0]?.id === encounterCreate.json.id,
  encounterList.text,
);
const encounterDocuments = await request(
  'GET', `/api/v1/documents?person_id=${person.json.id}&date_field=encounter`, { token },
);
check(
  'P0-3 encounter 日期语义参与文档列表',
  encounterDocuments.status === 200
    && encounterDocuments.json?.documents?.[0]?.dates?.selected_date === '2026-08-27',
  encounterDocuments.text,
);

const documentSearch = await request(
  'GET', `/api/v1/search?person_id=${person.json.id}&q=${encodeURIComponent('Core 人工血脂')}`, { token },
);
check(
  'P0-7 keyword 检索命中文档人工事实',
  documentSearch.status === 200
    && documentSearch.json?.coverage === 'core_manual'
    && documentSearch.json?.results?.[0]?.entity_type === 'document'
    && documentSearch.json?.results?.[0]?.document_id === created.json.id,
  documentSearch.text,
);
const encounterSearch = await request(
  'GET', `/api/v1/search?person_id=${person.json.id}&q=${encodeURIComponent('复查血脂')}`, { token },
);
check(
  'P0-7 keyword 检索命中 encounter 人工事实',
  encounterSearch.status === 200
    && encounterSearch.json?.results?.[0]?.entity_type === 'encounter'
    && encounterSearch.json?.results?.[0]?.document_id === null,
  encounterSearch.text,
);
const semanticSearch = await request(
  'GET', `/api/v1/search?person_id=${person.json.id}&q=血脂&mode=semantic`, { token },
);
check(
  'P0-7 无语义插件时显式 fail closed',
  semanticSearch.status === 503 && semanticSearch.json?.error?.code === 'capability_unavailable',
  semanticSearch.text,
);

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
await sql`
  update document set
    doc_type = 'imaging_report', reported_on = '2026-08-28',
    facility_name_raw = '旧 AI 医院建议', department_raw = '心内科',
    s1_prompt_version = 1
  where id = ${created.json.id}
`;
const beforeLegacyAccept = await request(
  'GET', `/api/v1/documents?person_id=${person.json.id}`, { token },
);
check(
  'P0-5 未确认 legacy 值不进入 effective metadata',
  beforeLegacyAccept.status === 200
    && beforeLegacyAccept.json?.documents?.[0]?.effective_metadata?.doc_type?.value === 'lab_report'
    && beforeLegacyAccept.json?.documents?.[0]?.effective_metadata?.department?.value === null
    && beforeLegacyAccept.json?.documents?.[0]?.effective_metadata?.facility_name?.value === null,
  beforeLegacyAccept.text,
);
const migrationInbox = await request(
  'GET', `/api/v1/metadata-migration-inbox?person_id=${person.json.id}`, { token },
);
const legacySuggestion = migrationInbox.json?.items?.[0]?.suggestion;
check(
  'P0-5 off 模式仍实体化并显示 legacy suggestion',
  migrationInbox.status === 200
    && legacySuggestion?.document_id === created.json.id
    && legacySuggestion?.values?.department === '心内科'
    && legacySuggestion?.provenance?.plugin_id === 'legacy-stage1',
  migrationInbox.text,
);
const suggestionAcceptBody = {
  client_operation_id: '018f0000-0000-7000-8000-000000000121',
  if_revision: 1,
  fields: ['reported_on', 'facility_name_raw', 'department'],
  overrides: {},
};
const suggestionAccept = await request(
  'POST', `/api/v1/documents/${created.json.id}/metadata-suggestions/${legacySuggestion?.id}/accept`, {
    token, body: suggestionAcceptBody,
  },
);
check(
  'P0-5 接受建议复制字段事实与 provenance',
  suggestionAccept.status === 200
    && suggestionAccept.json?.revision === 2
    && suggestionAccept.json?.effective_metadata?.department?.value === '心内科'
    && suggestionAccept.json?.effective_metadata?.department?.source === 'accepted_suggestion'
    && suggestionAccept.json?.effective_metadata?.department?.suggestion_id === legacySuggestion?.id,
  suggestionAccept.text,
);
const suggestionReplay = await request(
  'POST', `/api/v1/documents/${created.json.id}/metadata-suggestions/${legacySuggestion?.id}/accept`, {
    token, body: suggestionAcceptBody,
  },
);
check(
  'P0-5 接受建议同 operation 返回首次完整响应',
  suggestionReplay.status === 200
    && suggestionReplay.json?.revision === suggestionAccept.json?.revision
    && suggestionReplay.json?.before?.department === suggestionAccept.json?.before?.department,
  suggestionReplay.text,
);
await sql`delete from processing_suggestion where id = ${legacySuggestion?.id}`;
await sql`
  update document set doc_type = 'unknown', reported_on = null, facility_name_raw = null,
    department_raw = null, s1_artifact_key = null, s1_prompt_version = null
  where id = ${created.json.id}
`;
const suggestionReplayWithoutL2 = await request(
  'POST', `/api/v1/documents/${created.json.id}/metadata-suggestions/${legacySuggestion?.id}/accept`, {
    token, body: suggestionAcceptBody,
  },
);
check(
  'P0-6 删除 L2 suggestion 后已接受事实仍可幂等重放',
  suggestionReplayWithoutL2.status === 200
    && suggestionReplayWithoutL2.json?.effective_metadata?.department?.value === '心内科',
  suggestionReplayWithoutL2.text,
);
const acceptedSearch = await request(
  'GET', `/api/v1/search?person_id=${person.json.id}&q=${encodeURIComponent('心内科')}`, { token },
);
check(
  'P0-7 已接受建议进入 core_manual 检索',
  acceptedSearch.status === 200
    && acceptedSearch.json?.coverage === 'core_manual'
    && acceptedSearch.json?.results?.[0]?.entity_id === created.json.id,
  acceptedSearch.text,
);

await sql`
  update document set doc_type = 'imaging_report', sampled_on = '2026-08-26',
    s1_prompt_version = 2
  where id = ${created.json.id}
`;
const secondInbox = await request(
  'GET', `/api/v1/metadata-migration-inbox?person_id=${person.json.id}`, { token },
);
const secondSuggestion = secondInbox.json?.items?.[0]?.suggestion;
const batchAccept = await request('POST', '/api/v1/metadata-migration-inbox:batch-accept', {
  token,
  body: {
    items: [
      {
        document_id: created.json.id,
        suggestion_id: secondSuggestion?.id,
        client_operation_id: '018f0000-0000-7000-8000-000000000122',
        if_revision: 2,
        fields: ['sampled_on'],
        overrides: {},
      },
      {
        document_id: created.json.id,
        suggestion_id: secondSuggestion?.id,
        client_operation_id: '018f0000-0000-7000-8000-000000000123',
        if_revision: 2,
        fields: ['doc_type'],
        overrides: {},
      },
    ],
  },
});
check(
  'P0-5 batch accept 逐项返回成功与 revision conflict',
  batchAccept.status === 200
    && batchAccept.json?.results?.[0]?.ok === true
    && batchAccept.json?.results?.[0]?.result?.revision === 3
    && batchAccept.json?.results?.[1]?.ok === false
    && batchAccept.json?.results?.[1]?.error?.code === 'revision_conflict',
  batchAccept.text,
);
const undoAcceptedField = await request('PATCH', `/api/v1/documents/${created.json.id}/metadata`, {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000124',
    if_revision: 3,
    sampled_on: null,
  },
});
check(
  'P0-5 普通 metadata revision 可撤销已接受字段',
  undoAcceptedField.status === 200
    && undoAcceptedField.json?.revision === 4
    && undoAcceptedField.json?.effective_metadata?.sampled_on?.value === null
    && undoAcceptedField.json?.effective_metadata?.sampled_on?.source === 'manual',
  undoAcceptedField.text,
);
await sql`delete from processing_suggestion`;
await sql`
  update document set doc_type = 'unknown', sampled_on = null, s1_prompt_version = null
  where id = ${created.json.id}
`;

const searchPageOne = await request(
  'GET', `/api/v1/search?person_id=${person.json.id}&q=${encodeURIComponent('血脂')}&limit=1`, { token },
);
const searchPageTwo = await request(
  'GET', `/api/v1/search?person_id=${person.json.id}&q=${encodeURIComponent('血脂')}&limit=1&cursor=${encodeURIComponent(searchPageOne.json?.next_cursor ?? '')}`,
  { token },
);
check(
  'P0-8 keyword 检索按 sort_at/id 稳定翻页',
  searchPageOne.status === 200
    && typeof searchPageOne.json?.next_cursor === 'string'
    && searchPageTwo.status === 200
    && searchPageTwo.json?.results?.length === 1
    && searchPageTwo.json?.results?.[0]?.entity_id !== searchPageOne.json?.results?.[0]?.entity_id,
  `${searchPageOne.text} / ${searchPageTwo.text}`,
);

const imageDetail = await request('GET', `/api/v1/documents/${created.json.id}`, { token });
check(
  'P0-9 图片详情返回原件、大图入口、人工 metadata 与 encounter',
  imageDetail.status === 200
    && imageDetail.json?.pages?.[0]?.preview_kind === 'image'
    && typeof imageDetail.json?.pages?.[0]?.preview_endpoint === 'string'
    && typeof imageDetail.json?.pages?.[0]?.original_url === 'string'
    && imageDetail.json?.effective_metadata?.department?.value === '心内科'
    && imageDetail.json?.encounters?.[0]?.id === encounterCreate.json.id,
  imageDetail.text,
);

const pdf = await PDFDocument.create();
pdf.addPage([595, 842]);
const pdfBytes = Buffer.from(await pdf.save());
const pdfSha256 = createHash('sha256').update(pdfBytes).digest('hex');
const pdfPresign = await request('POST', '/api/v1/uploads/presign', {
  token,
  body: {
    person_id: person.json.id,
    files: [{
      filename: 'core-off-report.pdf', mime_type: 'application/pdf',
      byte_size: pdfBytes.length, sha256: pdfSha256,
    }],
  },
});
const pdfUpload = pdfPresign.json?.uploads?.[0];
const pdfPut = await fetch(pdfUpload.url, {
  method: 'PUT', headers: pdfUpload.headers, body: pdfBytes,
});
const pdfDocument = await request('POST', '/api/v1/documents', {
  token,
  body: {
    person_id: person.json.id,
    person_confirmed: true,
    batch_id: pdfPresign.json.batch_id,
    source: 'pdf',
    captured_at: '2026-08-28T13:00:00+08:00',
    pages: [{
      upload_id: pdfUpload.upload_id, page_no: 1, width: 595, height: 842, sha256: pdfSha256,
    }],
    client_document_id: 'core-off-document-pdf-0001',
  },
});
const pdfDetail = await request('GET', `/api/v1/documents/${pdfDocument.json?.id}`, { token });
check(
  'P0-9 PDF 详情提供浏览器原件 fallback 而非虚假缩略图',
  pdfPut.ok
    && pdfDocument.status === 201
    && pdfDetail.status === 200
    && pdfDetail.json?.pages?.[0]?.preview_kind === 'pdf_browser'
    && pdfDetail.json?.pages?.[0]?.preview_endpoint === null
    && typeof pdfDetail.json?.pages?.[0]?.original_url === 'string',
  `${pdfDocument.text} / ${pdfDetail.text}`,
);

const sampledNull = await request(
  'GET', `/api/v1/documents?person_id=${person.json.id}&date_field=sampled&from=2026-08-27&to=2026-08-27`,
  { token },
);
const reportedRange = await request(
  'GET', `/api/v1/documents?person_id=${person.json.id}&date_field=reported&from=2026-08-28&to=2026-08-28`,
  { token },
);
const encounterRange = await request(
  'GET', `/api/v1/documents?person_id=${person.json.id}&date_field=encounter&from=2026-08-27&to=2026-08-27`,
  { token },
);
const capturePageOne = await request(
  'GET', `/api/v1/documents?person_id=${person.json.id}&date_field=capture&from=2026-08-28&to=2026-08-28&limit=1`,
  { token },
);
const capturePageTwo = await request(
  'GET', `/api/v1/documents?person_id=${person.json.id}&date_field=capture&from=2026-08-28&to=2026-08-28&limit=1&cursor=${encodeURIComponent(capturePageOne.json?.next_cursor ?? '')}`,
  { token },
);
const bestAvailable = await request(
  'GET', `/api/v1/documents?person_id=${person.json.id}&date_field=best_available&from=2026-08-28&to=2026-08-28`,
  { token },
);
check(
  'P0-3 sampled NULL 在有范围时不入选',
  sampledNull.status === 200 && sampledNull.json?.documents?.length === 0,
  sampledNull.text,
);
check(
  'P0-3 reported/encounter 日期语义与范围边界正确',
  reportedRange.status === 200
    && reportedRange.json?.documents?.length === 1
    && reportedRange.json?.documents?.[0]?.id === created.json.id
    && reportedRange.json?.documents?.[0]?.dates?.selected_date === '2026-08-28'
    && encounterRange.status === 200
    && encounterRange.json?.documents?.length === 1
    && encounterRange.json?.documents?.[0]?.id === created.json.id
    && encounterRange.json?.documents?.[0]?.dates?.selected_date === '2026-08-27',
  `${reportedRange.text} / ${encounterRange.text}`,
);
check(
  'P0-3 capture 同日稳定 cursor 不重不漏',
  capturePageOne.status === 200
    && capturePageOne.json?.documents?.length === 1
    && typeof capturePageOne.json?.next_cursor === 'string'
    && capturePageTwo.status === 200
    && capturePageTwo.json?.documents?.length === 1
    && capturePageTwo.json?.documents?.[0]?.id !== capturePageOne.json?.documents?.[0]?.id
    && capturePageTwo.json?.next_cursor === null,
  `${capturePageOne.text} / ${capturePageTwo.text}`,
);
check(
  'P0-3 best-available 固定优先级并保留 capture fallback',
  bestAvailable.status === 200
    && bestAvailable.json?.documents?.length === 2
    && bestAvailable.json.documents.every((item: any) => item.dates?.selected_date === '2026-08-28'),
  bestAvailable.text,
);
const filteredDocuments = await request(
  'GET', `/api/v1/documents?person_id=${person.json.id}&date_field=best_available&doc_type=lab_report&department=${encodeURIComponent('心内科')}&encounter_id=${encounterCreate.json.id}&q=${encodeURIComponent('人工血脂')}`,
  { token },
);
check(
  'P0-3 文档类型/科室/encounter/关键词组合筛选',
  filteredDocuments.status === 200
    && filteredDocuments.json?.documents?.length === 1
    && filteredDocuments.json?.documents?.[0]?.id === created.json.id,
  filteredDocuments.text,
);

const genericTemplateResponse = await request(
  'GET', '/api/v1/context/templates/generic/versions/1', { token },
);
const genericQuestions = resolvedQuestions(genericTemplateResponse.json, 'anytime', profile);
const standaloneSessionId = '018f0000-0000-7000-8000-000000000211';
const standaloneCreate = await request('POST', '/api/v1/context/sessions', {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000212',
    id: standaloneSessionId, person_id: person.json.id,
    scope_type: 'standalone', scope_key: standaloneSessionId,
    client_document_id: null, document_id: null, encounter_id: null,
    template_id: 'generic', template_version: 1,
    template_hash: genericTemplateResponse.json?.template_hash,
    question_snapshot: genericQuestions, stage: 'anytime',
  },
});
const standaloneAnswers = await request(
  'POST', `/api/v1/context/sessions/${standaloneSessionId}/answers`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000213', if_revision: 1,
      answers: [
        { question_key: 'event_date', answer_type: 'date', value: '2026-08-20', skipped: false },
        { question_key: 'event_note', answer_type: 'text', value: '独立记录的家庭健康事件', skipped: false },
      ],
    },
  },
);
const standaloneComplete = await request(
  'POST', `/api/v1/context/sessions/${standaloneSessionId}/complete`, {
    token,
    body: { client_operation_id: '018f0000-0000-7000-8000-000000000214', if_revision: 2 },
  },
);
check(
  'P1-1 standalone anytime 不伪造 document 且可回答/完成',
  standaloneCreate.status === 201
    && standaloneCreate.json?.session?.document_id === null
    && standaloneAnswers.status === 200
    && standaloneAnswers.json?.answers?.some((answer: any) => (
      answer.question_key === 'event_date'
      && answer.event_on === '2026-08-20'
      && answer.time_precision === 'date'
    ))
    && standaloneComplete.status === 200
    && standaloneComplete.json?.session?.status === 'completed',
  `${standaloneCreate.text} / ${standaloneAnswers.text} / ${standaloneComplete.text}`,
);

const checkupTemplateResponse = await request(
  'GET', '/api/v1/context/templates/checkup-report/versions/1', { token },
);
const checkupQuestions = resolvedQuestions(checkupTemplateResponse.json, 'onsite', profile);
const checkupSessionId = '018f0000-0000-7000-8000-000000000221';
const checkupCreate = await request('POST', '/api/v1/context/sessions', {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000222',
    id: checkupSessionId, person_id: person.json.id,
    scope_type: 'standalone', scope_key: checkupSessionId,
    client_document_id: null, document_id: null, encounter_id: null,
    template_id: 'checkup-report', template_version: 1,
    template_hash: checkupTemplateResponse.json?.template_hash,
    question_snapshot: checkupQuestions, stage: 'onsite',
  },
});
const checkupAnswers = await request(
  'POST', `/api/v1/context/sessions/${checkupSessionId}/answers`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000223', if_revision: 1,
      answers: [
        { question_key: 'checkup_type', answer_type: 'choice', value: 'self_paid', skipped: false },
        { question_key: 'fasting_status', answer_type: 'choice', value: 'fasting', skipped: false },
        { question_key: 'fasting_hours', answer_type: 'number', value: 12, skipped: false },
        { question_key: 'abnormal_noted', answer_type: 'text', value: '人工备注：胆固醇偏高', skipped: false },
      ],
    },
  },
);
const checkupComplete = await request(
  'POST', `/api/v1/context/sessions/${checkupSessionId}/complete`, {
    token,
    body: { client_operation_id: '018f0000-0000-7000-8000-000000000224', if_revision: 2 },
  },
);
check(
  'P1-4 number 与 audio 文字替代从真实模板产品路径保存',
  checkupCreate.status === 201
    && checkupQuestions.length === 4
    && checkupAnswers.status === 200
    && checkupAnswers.json?.answers?.some((answer: any) => (
      answer.question_key === 'fasting_hours' && answer.answer_type === 'number' && answer.value === 12
    ))
    && checkupAnswers.json?.answers?.some((answer: any) => (
      answer.question_key === 'abnormal_noted' && answer.answer_type === 'text'
    ))
    && checkupComplete.status === 200,
  `${checkupCreate.text} / ${checkupAnswers.text} / ${checkupComplete.text}`,
);

const labSameDayQuestions = resolvedQuestions(labTemplate, 'same_day', profile);
const sameDaySessionId = '018f0000-0000-7000-8000-000000000231';
const sameDayCreate = await request('POST', '/api/v1/context/sessions', {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000232',
    id: sameDaySessionId, person_id: person.json.id,
    scope_type: 'standalone', scope_key: sameDaySessionId,
    client_document_id: null, document_id: null, encounter_id: encounterCreate.json.id,
    template_id: 'lab-report', template_version: 1, template_hash: labTemplate?.template_hash,
    question_snapshot: labSameDayQuestions, stage: 'same_day',
  },
});
const sameDayLocalDate = localDateAt(sameDayCreate.json?.session?.created_at, 'Asia/Shanghai');
const pendingBefore = await request(
  'GET', `/api/v1/context/pending?person_id=${person.json.id}&local_date=${sameDayLocalDate}`, { token },
);
check(
  'P1-7 same_day 活跃 session 进入账户时区 pending',
  sameDayCreate.status === 201
    && pendingBefore.status === 200
    && pendingBefore.json?.sessions?.some((session: any) => session.id === sameDaySessionId),
  `${sameDayCreate.text} / ${pendingBefore.text}`,
);

const audioBytes = silentWav();
const audioMedia = await uploadContextMedia({
  token, personId: person.json.id, sessionId: sameDaySessionId,
  questionKey: 'doctor_advice', kind: 'audio', mime: 'audio/wav', bytes: audioBytes,
  prepareOperationId: '018f0000-0000-7000-8000-000000000233',
  finalizeOperationId: '018f0000-0000-7000-8000-000000000234',
});
const photoMedia = await uploadContextMedia({
  token, personId: person.json.id, sessionId: sameDaySessionId,
  questionKey: 'medication_photo', kind: 'photo', mime: 'image/jpeg', bytes,
  prepareOperationId: '018f0000-0000-7000-8000-000000000235',
  finalizeOperationId: '018f0000-0000-7000-8000-000000000236',
});
const audioView = await request(
  'GET', `/api/v1/context/uploads/${audioMedia.prepare.json?.id}`, { token },
);
const audioRead = await fetch(audioView.json?.url);
const audioReadBytes = Buffer.from(await audioRead.arrayBuffer());
const photoView = await request(
  'GET', `/api/v1/context/uploads/${photoMedia.prepare.json?.id}`, { token },
);
check(
  'P1-5/P1-6 音频与照片经安全 finalize 成为可读取 L1，完全不需要 ASR',
  audioMedia.prepare.status === 201
    && audioMedia.presign.status === 200
    && audioMedia.presign.json?.mode === 'single'
    && audioMedia.put.ok
    && audioMedia.finalize.status === 200
    && audioMedia.finalize.json?.upload?.state === 'finalized'
    && audioView.status === 200
    && audioRead.ok
    && createHash('sha256').update(audioReadBytes).digest('hex')
      === createHash('sha256').update(audioBytes).digest('hex')
    && photoMedia.prepare.status === 201
    && photoMedia.put.ok
    && photoMedia.finalize.status === 200
    && photoMedia.finalize.json?.upload?.state === 'finalized'
    && photoView.status === 200,
  `${audioMedia.prepare.text} / ${audioMedia.finalize.text} / ${photoMedia.prepare.text} / ${photoMedia.finalize.text}`,
);

const tamperExpected = Buffer.from(audioBytes);
tamperExpected[tamperExpected.length - 1] = 1;
const tamperSha = createHash('sha256').update(tamperExpected).digest('hex');
const tamperPrepare = await request('POST', '/api/v1/context/uploads/prepare', {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000237',
    person_id: person.json.id, session_id: sameDaySessionId,
    question_key: 'doctor_advice', kind: 'audio', mime: 'audio/wav',
    byte_size: tamperExpected.length, sha256: tamperSha,
  },
});
const tamperPresign = await request(
  'POST', `/api/v1/context/uploads/${tamperPrepare.json?.id}/presign`, { token },
);
const tamperPut = await fetch(tamperPresign.json?.url, {
  method: 'PUT', headers: tamperPresign.json?.headers, body: audioBytes,
});
const tamperFinalize = await request(
  'POST', `/api/v1/context/uploads/${tamperPrepare.json?.id}/finalize`, {
    token,
    body: { client_operation_id: '018f0000-0000-7000-8000-000000000238', parts: [] },
  },
);
const crossPersonPrepare = await request('POST', '/api/v1/context/uploads/prepare', {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000241',
    person_id: otherPerson.json.id, session_id: sameDaySessionId,
    question_key: 'doctor_advice', kind: 'audio', mime: 'audio/wav',
    byte_size: audioBytes.length,
    sha256: createHash('sha256').update(audioBytes).digest('hex'),
  },
});
check(
  'P1-5 替换对象和跨 person/session 媒体意图均被拒绝',
  (!tamperPut.ok || (
    tamperFinalize.status === 409
    && ['upload_incomplete', 'sha256_mismatch'].includes(tamperFinalize.json?.error?.code)
  ))
    && crossPersonPrepare.status === 404
    && crossPersonPrepare.json?.error?.code === 'not_found',
  `put=${tamperPut.status} / ${tamperFinalize.text} / ${crossPersonPrepare.text}`,
);
await sql`delete from context_upload where id = ${tamperPrepare.json?.id}`;

const sameDayAnswers = await request(
  'POST', `/api/v1/context/sessions/${sameDaySessionId}/answers`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000239', if_revision: 1,
      answers: [
        {
          question_key: 'doctor_advice', answer_type: 'audio',
          value: { upload_id: audioMedia.prepare.json?.id }, skipped: false,
        },
        {
          question_key: 'medication_changes', answer_type: 'text',
          value: '改为每日一次，人工文字替代', skipped: false,
        },
        {
          question_key: 'medication_photo', answer_type: 'photo',
          value: { upload_id: photoMedia.prepare.json?.id }, skipped: false,
        },
        { question_key: 'followup_plan', answer_type: 'date', value: '2026-09-15', skipped: false },
      ],
    },
  },
);
const sameDayComplete = await request(
  'POST', `/api/v1/context/sessions/${sameDaySessionId}/complete`, {
    token,
    body: { client_operation_id: '018f0000-0000-7000-8000-000000000240', if_revision: 2 },
  },
);
const pendingAfter = await request(
  'GET', `/api/v1/context/pending?person_id=${person.json.id}&local_date=${sameDayLocalDate}`, { token },
);
check(
  'P1-4/P1-7 finalized audio/photo 可绑定回答，完成后退出 pending',
  sameDayAnswers.status === 200
    && sameDayAnswers.json?.answers?.some((answer: any) => (
      answer.answer_type === 'audio' && answer.upload_id === audioMedia.prepare.json?.id
    ))
    && sameDayAnswers.json?.answers?.some((answer: any) => (
      answer.answer_type === 'photo' && answer.upload_id === photoMedia.prepare.json?.id
    ))
    && sameDayComplete.status === 200
    && pendingAfter.status === 200
    && !pendingAfter.json?.sessions?.some((session: any) => session.id === sameDaySessionId),
  `${sameDayAnswers.text} / ${sameDayComplete.text} / ${pendingAfter.text}`,
);

const contextSearch = await request(
  'GET', `/api/v1/search?person_id=${person.json.id}&q=${encodeURIComponent('独立记录的家庭健康事件')}`,
  { token },
);
const contextMappedEncounter = await request(
  'GET', `/api/v1/people/${person.json.id}/encounters`, { token },
);
check(
  'P1-8 context 进入自身搜索投影，但 maps_to 不静默改写其他 L1 事实',
  contextSearch.status === 200
    && contextSearch.json?.results?.[0]?.entity_type === 'context_answer'
    && contextSearch.json?.results?.[0]?.document_id === null
    && contextMappedEncounter.status === 200
    && contextMappedEncounter.json?.encounters?.find((item: any) => item.id === encounterCreate.json.id)
      ?.chief_complaint === '复查血脂',
  `${contextSearch.text} / ${contextMappedEncounter.text}`,
);

// ── P2：完全无 AI 的人工 Observation 与 concept mapping 主链 ──
const conceptCatalog = await request(
  'GET', `/api/v1/medical/concepts?q=${encodeURIComponent('肌酐')}&kind=laboratory`, { token },
);
const creatinineConcept = conceptCatalog.json?.concepts?.find((item: any) => item.code === 'CREATININE');
check(
  'P2-4/P2-5 本地 concept catalog 在 off 模式可用',
  conceptCatalog.status === 200
    && creatinineConcept?.catalog_version === '2026.08'
    && creatinineConcept?.canonical_unit === 'umol/L',
  conceptCatalog.text,
);

const invalidObservationBatch = await request(
  'POST', `/api/v1/people/${person.json.id}/observations:batch`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000301', defaults: {},
      observations: [
        {
          client_row_id: '018f0000-0000-7000-8000-000000000302', observed_on: '2026-08-28',
          local_name: '血糖', value_raw: '5.6', unit_raw: 'mmol/L',
        },
        {
          client_row_id: '018f0000-0000-7000-8000-000000000303',
          local_name: '未填日期', value_raw: '1',
        },
      ],
    },
  },
);
const observationsAfterInvalid = await request(
  'GET', `/api/v1/people/${person.json.id}/observations`, { token },
);
check(
  'P2-1 无效行返回行级路径且整批 0 写入',
  invalidObservationBatch.status === 400
    && invalidObservationBatch.text.includes('observations')
    && invalidObservationBatch.text.includes('observed_on')
    && observationsAfterInvalid.status === 200
    && observationsAfterInvalid.json?.observations?.length === 0,
  `${invalidObservationBatch.text} / ${observationsAfterInvalid.text}`,
);

const observationBatchBody = {
  client_operation_id: '018f0000-0000-7000-8000-000000000304',
  defaults: {
    document_id: created.json.id, encounter_id: encounterCreate.json.id,
    observed_on: '2026-08-27', time_precision: 'date', date_source: 'document_sampled',
    specimen: 'serum', specimen_label: '血清', method: 'enzymatic',
  },
  observations: [
    {
      client_row_id: '018f0000-0000-7000-8000-000000000305', local_name: '肌酐',
      concept_code: 'CREATININE', concept_catalog_version: '2026.08',
      value_raw: '<1.20', unit_raw: 'mg/dL', ref_low: 0.5, ref_high: 1.3,
      abnormal_flag_raw: 'N', abnormal_flag: 'normal', qualifier: 'fasting',
      body_site: 'blood', extra_dims: { posture: 'seated' }, result_kind: 'measured',
      source_page: {
        origin_capture_document_id: created.json.id, origin_capture_order: 1,
        object_sha256: sha256, logical_page_index: 1,
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      },
    },
    {
      client_row_id: '018f0000-0000-7000-8000-000000000306', local_name: '本院血糖',
      value_raw: '5.6', unit_raw: '本院U', result_kind: 'measured',
    },
  ],
};
const observationBatch = await request(
  'POST', `/api/v1/people/${person.json.id}/observations:batch`, {
    token, body: observationBatchBody,
  },
);
const observationBatchReplay = await request(
  'POST', `/api/v1/people/${person.json.id}/observations:batch`, {
    token, body: observationBatchBody,
  },
);
const creatinineObservation = observationBatch.json?.observations?.[0];
const unmappedObservation = observationBatch.json?.observations?.[1];
const derivedBeforePatchResponse = await request(
  'GET', `/api/v1/people/${person.json.id}/observations?source=derived&concept_code=EGFR_CKD_EPI_2021`,
  { token },
);
const egfrBeforePatch = derivedBeforePatchResponse.json?.observations?.[0];
check(
  'P2-2/P2-3/P2-4 原值、日期精度、比较符、换算和稳定来源不丢失',
  observationBatch.status === 201
    && observationBatchReplay.status === 201
    && observationBatchReplay.json?.observations?.[0]?.id === creatinineObservation?.id
    && creatinineObservation?.value_raw === '<1.20'
    && creatinineObservation?.value_num === 1.2
    && creatinineObservation?.comparator === '<'
    && creatinineObservation?.value_si === 106.08
    && creatinineObservation?.unit_si === 'umol/L'
    && creatinineObservation?.conversion_version === 'medical-units@1'
    && creatinineObservation?.observed_at === null
    && creatinineObservation?.time_precision === 'date'
    && creatinineObservation?.extra_dims?.posture === 'seated'
    && creatinineObservation?.source_page?.origin_capture_document_id === created.json.id
    && creatinineObservation?.source_page?.current_document_id === created.json.id
    && creatinineObservation?.source_page?.source_available === true
    && unmappedObservation?.mapping_status === 'unmapped'
    && observationBatch.json?.warnings?.some((warning: any) => (
      warning.client_row_id === unmappedObservation?.client_row_id && warning.code === 'unknown_unit'
    ))
    && observationBatch.json?.warnings?.some((warning: any) => (
      warning.client_row_id === unmappedObservation?.client_row_id && warning.code === 'unmapped_concept'
    )),
  `${observationBatch.text} / ${observationBatchReplay.text}`,
);

const observationPatch = await request(
  'PATCH', `/api/v1/observations/${creatinineObservation?.id}`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000307', if_revision: 1,
      correction_note: '核对原件后修正小数', value_raw: '<1.10',
    },
  },
);
const derivedAfterPatchResponse = await request(
  'GET', `/api/v1/people/${person.json.id}/observations?source=derived&concept_code=EGFR_CKD_EPI_2021`,
  { token },
);
const egfrAfterPatch = derivedAfterPatchResponse.json?.observations?.[0];
const observationConflict = await request(
  'PATCH', `/api/v1/observations/${creatinineObservation?.id}`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000308', if_revision: 1,
      correction_note: '过期草稿', value_raw: '1.0', value_num: 1,
    },
  },
);
check(
  'P2-6 修正 note/before-after/revision conflict 语义正确',
  observationPatch.status === 200
    && observationPatch.json?.revision === 2
    && observationPatch.json?.review_status === 'corrected'
    && observationPatch.json?.value_si === 97.24
    && observationConflict.status === 409
    && observationConflict.json?.error?.code === 'revision_conflict'
    && observationConflict.json?.error?.details?.current?.revision === 2,
  `${observationPatch.text} / ${observationConflict.text}`,
);
check(
  'P2-9 派生事实保持稳定身份并随输入 revision 确定性重算',
  derivedBeforePatchResponse.status === 200
    && derivedAfterPatchResponse.status === 200
    && egfrBeforePatch?.source === 'derived'
    && egfrBeforePatch?.is_derived === true
    && egfrBeforePatch?.derived_formula === 'CKD-EPI 2021 creatinine'
    && egfrBeforePatch?.calculation_version === 'ckd-epi-2021@1'
    && egfrBeforePatch?.input_observation_ids?.length === 1
    && egfrBeforePatch?.input_observation_ids?.[0] === creatinineObservation?.id
    && egfrAfterPatch?.id === egfrBeforePatch?.id
    && egfrAfterPatch?.derivation_key === egfrBeforePatch?.derivation_key
    && egfrAfterPatch?.input_revision_hash !== egfrBeforePatch?.input_revision_hash
    && egfrAfterPatch?.value_num !== egfrBeforePatch?.value_num,
  `${derivedBeforePatchResponse.text} / ${derivedAfterPatchResponse.text}`,
);

const mappingInbox = await request(
  'GET', `/api/v1/people/${person.json.id}/observation-mapping-inbox`, { token },
);
const mappingItem = mappingInbox.json?.items?.find((item: any) => (
  item.observation_ids?.includes(unmappedObservation?.id)
));
const mappingResolve = await request(
  'POST', `/api/v1/people/${person.json.id}/observation-mapping-inbox:resolve`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000309', mode: 'selected',
      input_fingerprint: mappingItem?.input_fingerprint, local_name: mappingItem?.local_name,
      context: mappingItem?.context, concept_code: 'GLUCOSE', catalog_version: '2026.08',
      rows: [{ observation_id: unmappedObservation?.id, if_revision: 1 }],
    },
  },
);
check(
  'P2-5 mapping inbox/alias/resolve 原子更新已有事实',
  mappingInbox.status === 200
    && mappingItem?.count === 1
    && mappingResolve.status === 200
    && mappingResolve.json?.alias?.state === 'confirmed'
    && mappingResolve.json?.observations?.[0]?.concept_code === 'GLUCOSE'
    && mappingResolve.json?.observations?.[0]?.revision === 2
    && typeof mappingResolve.json?.series_selectors?.[0]?.series_key === 'string',
  `${mappingInbox.text} / ${mappingResolve.text}`,
);

const postAliasBatch = await request(
  'POST', `/api/v1/people/${person.json.id}/observations:batch`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000310',
      defaults: {
        observed_on: '2026-08-28', specimen: 'serum', method: 'enzymatic',
      },
      observations: [
        {
          client_row_id: '018f0000-0000-7000-8000-000000000311', local_name: '本院血糖',
          value_raw: '6.1', unit_raw: 'mmol/L',
        },
        {
          client_row_id: '018f0000-0000-7000-8000-000000000312', local_name: '来源缺失检查',
          value_raw: '阴性', unit_raw: '本院U',
          source_page: {
            origin_capture_document_id: created.json.id, origin_capture_order: 99,
            object_sha256: 'a'.repeat(64), logical_page_index: 1, bbox: null,
          },
        },
      ],
    },
  },
);
const aliasAppliedObservation = postAliasBatch.json?.observations?.[0];
const unavailableObservation = postAliasBatch.json?.observations?.[1];
check(
  'P2-5/P2-11 已确认 alias 自动用于新人工行，原件缺失时不猜测',
  postAliasBatch.status === 201
    && aliasAppliedObservation?.concept_code === 'GLUCOSE'
    && aliasAppliedObservation?.mapping_status === 'mapped'
    && unavailableObservation?.source_page?.source_available === false
    && unavailableObservation?.source_page?.current_document_id === null
    && postAliasBatch.json?.warnings?.some((warning: any) => (
      warning.client_row_id === unavailableObservation?.client_row_id
      && warning.code === 'source_unavailable'
    )),
  postAliasBatch.text,
);

const archiveObservation = await request(
  'POST', `/api/v1/observations/${aliasAppliedObservation?.id}/archive`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000313',
      if_revision: 1, correction_note: '重复录入',
    },
  },
);
const activeObservations = await request(
  'GET', `/api/v1/people/${person.json.id}/observations?limit=2`, { token },
);
const observationSearch = await request(
  'GET', `/api/v1/search?person_id=${person.json.id}&q=${encodeURIComponent('肌酐')}`, { token },
);
check(
  'P2-6 归档从活跃列表/搜索投影移除，列表游标稳定',
  archiveObservation.status === 200
    && archiveObservation.json?.archived_at !== null
    && activeObservations.status === 200
    && activeObservations.json?.observations?.length === 2
    && typeof activeObservations.json?.next_cursor === 'string'
    && !activeObservations.json?.observations?.some((item: any) => item.id === aliasAppliedObservation?.id)
    && observationSearch.status === 200
    && observationSearch.json?.results?.some((item: any) => (
      item.entity_type === 'observation' && item.entity_id === creatinineObservation?.id
    )),
  `${archiveObservation.text} / ${activeObservations.text} / ${observationSearch.text}`,
);

const crossPersonObservation = await request(
  'POST', `/api/v1/people/${otherPerson.json.id}/observations:batch`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000314',
      defaults: { observed_on: '2026-08-28' },
      observations: [{
        client_row_id: '018f0000-0000-7000-8000-000000000315', local_name: '跨人来源',
        value_raw: '1', source_page: {
          origin_capture_document_id: created.json.id, origin_capture_order: 1,
          object_sha256: sha256, logical_page_index: 1, bbox: null,
        },
      }],
    },
  },
);
check(
  'P2-8 稳定来源跨 person 统一拒绝且不泄漏',
  crossPersonObservation.status === 404
    && crossPersonObservation.json?.error?.code === 'not_found',
  crossPersonObservation.text,
);

const observationSuggestionId = '018f0000-0000-7000-8000-000000000316';
await sql`
  insert into processing_suggestion
    (id, capability, subject_type, subject_id, person_id, input_revision, input_sha256,
     payload, plugin_id, plugin_version, provider, model, prompt_id, prompt_version,
     artifact_key, artifact_sha256, state)
  values
    (${observationSuggestionId}, 'observation_suggest', 'document', ${created.json.id},
     ${person.json.id}, 7, ${'b'.repeat(64)}, ${sql.json({
       defaults: {
         observed_on: '2026-08-27', time_precision: 'date', date_source: 'document_sampled',
         specimen: 'plasma', method: null, device: null,
       },
       rows: [
         {
           row_id: 'suggested-glucose-1',
           draft: {
             local_name: '葡萄糖', concept_code: 'GLUCOSE',
             concept_catalog_version: '2026.08', value_raw: '5.0', unit_raw: 'mmol/L',
             source_page: {
               origin_capture_document_id: created.json.id, origin_capture_order: 1,
               object_sha256: sha256, logical_page_index: 1, bbox: null,
             },
           },
         },
         {
           row_id: 'suggested-glucose-2',
           draft: {
             local_name: '葡萄糖', concept_code: 'GLUCOSE',
             concept_catalog_version: '2026.08', value_raw: '5.2', unit_raw: 'mmol/L',
           },
         },
       ],
     })}, 'fixture-observation-plugin', '1.0.0', 'fixture-provider', 'fixture-model',
     'observation-extract', '1', 'people/p/artifacts/observation.json', ${'c'.repeat(64)},
     'proposed')
`;
const observationSuggestions = await request(
  'GET', `/api/v1/documents/${created.json.id}/observation-suggestions`, { token },
);
const observationSuggestionAcceptBody = {
  client_operation_id: '018f0000-0000-7000-8000-000000000317',
  if_input_revision: 7,
  rows: [{
    suggestion_row_id: 'suggested-glucose-1',
    client_row_id: '018f0000-0000-7000-8000-000000000318',
    overrides: { value_raw: '4.9', abnormal_flag_raw: 'N', abnormal_flag: 'normal' },
  }],
};
const observationSuggestionAccept = await request(
  'POST', `/api/v1/documents/${created.json.id}/observation-suggestions/${observationSuggestionId}/accept`, {
    token, body: observationSuggestionAcceptBody,
  },
);
const acceptedSuggestionObservation = observationSuggestionAccept.json?.observations?.[0];
check(
  'P2-7 suggestion 可逐行/逐字段接受并复制完整 provenance',
  observationSuggestions.status === 200
    && observationSuggestions.json?.suggestions?.[0]?.payload?.rows?.length === 2
    && observationSuggestionAccept.status === 200
    && observationSuggestionAccept.json?.accepted_row_ids?.[0] === 'suggested-glucose-1'
    && acceptedSuggestionObservation?.source === 'accepted_suggestion'
    && acceptedSuggestionObservation?.value_raw === '4.9'
    && acceptedSuggestionObservation?.value_num === 4.9
    && acceptedSuggestionObservation?.source_ref?.suggestion_id === observationSuggestionId
    && acceptedSuggestionObservation?.source_ref?.provenance?.plugin_id
      === 'fixture-observation-plugin',
  `${observationSuggestions.text} / ${observationSuggestionAccept.text}`,
);
await sql`delete from processing_suggestion where id = ${observationSuggestionId}`;
const observationSuggestionReplay = await request(
  'POST', `/api/v1/documents/${created.json.id}/observation-suggestions/${observationSuggestionId}/accept`, {
    token, body: observationSuggestionAcceptBody,
  },
);
check(
  'P2-7 删除 L2 suggestion 后已接受 Observation 仍可完整幂等重放',
  observationSuggestionReplay.status === 200
    && observationSuggestionReplay.json?.observations?.[0]?.id === acceptedSuggestionObservation?.id
    && observationSuggestionReplay.json?.observations?.[0]?.source_ref?.provenance?.model
      === 'fixture-model',
  observationSuggestionReplay.text,
);

// ── P3：监控组、趋势、RCV、来源与固定下采样（仍完全不需要 AI） ──
const trendObservationBatch = await request(
  'POST', `/api/v1/people/${person.json.id}/observations:batch`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000401', defaults: {},
      observations: [
        ...[4.0, 4.3, 4.1, 7.2, 5.4, 5.8].map((value, index) => ({
          client_row_id: `018f0000-0000-7000-8000-${String(402 + index).padStart(12, '0')}`,
          observed_on: `2026-08-${String(20 + index).padStart(2, '0')}`,
          time_precision: 'date', date_source: 'manual', local_name: '葡萄糖',
          concept_code: 'GLUCOSE', concept_catalog_version: '2026.08',
          value_raw: String(value), unit_raw: 'mmol/L', ref_low: index % 2 ? 4.0 : 3.9,
          ref_high: index % 2 ? 6.0 : 6.1, ref_unit: 'mmol/L',
          specimen: 'serum', method: 'enzymatic', result_kind: 'measured',
          source_page: {
            origin_capture_document_id: created.json.id, origin_capture_order: 1,
            object_sha256: sha256, logical_page_index: 1, bbox: null,
          },
        })),
        {
          client_row_id: '018f0000-0000-7000-8000-000000000408',
          observed_on: '2026-08-28', time_precision: 'date', date_source: 'manual',
          local_name: '葡萄糖', concept_code: 'GLUCOSE', concept_catalog_version: '2026.08',
          value_raw: '6.2', unit_raw: 'mmol/L', ref_low: 3.8, ref_high: 6.0,
          ref_unit: 'mmol/L', specimen: 'plasma', method: null, result_kind: 'measured',
        },
        {
          client_row_id: '018f0000-0000-7000-8000-000000000409',
          observed_on: '2026-08-25', time_precision: 'date', date_source: 'manual',
          local_name: '公式输入血糖', concept_code: 'GLUCOSE',
          concept_catalog_version: '2026.08', value_raw: '9.9', unit_raw: 'mmol/L',
          specimen: 'serum', method: 'enzymatic', result_kind: 'input_parameter',
        },
      ],
    },
  },
);
check(
  'P3-2 趋势验收事实可完全通过人工 batch 创建',
  trendObservationBatch.status === 201
    && trendObservationBatch.json?.observations?.length === 8,
  trendObservationBatch.text,
);

const serumSelector = {
  concept_code: 'GLUCOSE', qualifier: null, body_site: null, specimen: 'serum',
  method: 'enzymatic', device: null, measurement_setting: null, extra_dims: null,
  result_kind: 'measured',
};
const plasmaSelector = {
  concept_code: 'GLUCOSE', qualifier: null, body_site: null, specimen: 'plasma',
  method: null, device: null, measurement_setting: null, extra_dims: null,
  result_kind: 'measured',
};
const inputSelector = { ...serumSelector, result_kind: 'input_parameter' };
const metricGroupCreate = await request(
  'POST', `/api/v1/people/${person.json.id}/metric-groups`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000410',
      name: '血糖趋势', description: '人工确认指标',
      items: [
        { item_type: 'series', selector: serumSelector },
        { item_type: 'series', selector: plasmaSelector },
        { item_type: 'series', selector: inputSelector },
      ],
    },
  },
);
const metricGroupReplay = await request(
  'POST', `/api/v1/people/${person.json.id}/metric-groups`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000410',
      name: '血糖趋势', description: '人工确认指标',
      items: [
        { item_type: 'series', selector: serumSelector },
        { item_type: 'series', selector: plasmaSelector },
        { item_type: 'series', selector: inputSelector },
      ],
    },
  },
);
const metricGroupPatch = await request(
  'PATCH', `/api/v1/metric-groups/${metricGroupCreate.json?.id}`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000411', if_revision: 1,
      name: '代谢趋势',
      items: [
        { item_type: 'series', selector: plasmaSelector },
        { item_type: 'series', selector: serumSelector },
        { item_type: 'series', selector: inputSelector },
      ],
    },
  },
);
const metricGroupConflict = await request(
  'PATCH', `/api/v1/metric-groups/${metricGroupCreate.json?.id}`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000412',
      if_revision: 1, name: '过期修改',
    },
  },
);
check(
  'P3-1 监控组 CRUD/顺序/revision/operation replay 正确',
  metricGroupCreate.status === 201
    && metricGroupCreate.json?.items?.length === 3
    && metricGroupReplay.status === 201
    && metricGroupReplay.json?.id === metricGroupCreate.json?.id
    && metricGroupPatch.status === 200
    && metricGroupPatch.json?.revision === 2
    && metricGroupPatch.json?.name === '代谢趋势'
    && metricGroupPatch.json?.items?.[0]?.selector?.specimen === 'plasma'
    && metricGroupPatch.json?.items?.[1]?.position === 1
    && metricGroupConflict.status === 409
    && metricGroupConflict.json?.error?.code === 'revision_conflict',
  `${metricGroupCreate.text} / ${metricGroupPatch.text} / ${metricGroupConflict.text}`,
);

const presetGroup = await request(
  'POST', `/api/v1/people/${person.json.id}/metric-groups`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000413',
      name: '三高+', preset: 'three_high_plus',
    },
  },
);
const emptyTrend = await request(
  'GET', `/api/v1/metric-groups/${presetGroup.json?.id}/trend?max_points=100`, { token },
);
const presetArchive = await request(
  'POST', `/api/v1/metric-groups/${presetGroup.json?.id}/archive`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000414', if_revision: 1,
    },
  },
);
check(
  'P3-1/P3-9 “三高+”复制为用户 L1 组，0 点诚实返回并可归档',
  presetGroup.status === 201
    && presetGroup.json?.preset_origin === 'three_high_plus'
    && presetGroup.json?.items?.length === 10
    && emptyTrend.status === 200
    && emptyTrend.json?.state === 'empty'
    && emptyTrend.json?.total_points === 0
    && presetArchive.status === 200
    && presetArchive.json?.archived_at !== null,
  `${presetGroup.text} / ${emptyTrend.text} / ${presetArchive.text}`,
);

const creatinineSelector = {
  concept_code: 'CREATININE', qualifier: 'fasting', body_site: 'blood', specimen: 'serum',
  method: 'enzymatic', device: null, measurement_setting: null,
  extra_dims: { posture: 'seated' }, result_kind: 'measured',
};
const singlePointGroup = await request(
  'POST', `/api/v1/people/${person.json.id}/metric-groups`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000415', name: '肌酐',
      items: [{ item_type: 'series', selector: creatinineSelector }],
    },
  },
);
const singleTrend = await request(
  'GET', `/api/v1/metric-groups/${singlePointGroup.json?.id}/trend?max_points=100`, { token },
);
check(
  'P3-8/P3-9 单点趋势保留稳定来源/bbox，不伪造成趋势',
  singlePointGroup.status === 201
    && singleTrend.status === 200
    && singleTrend.json?.state === 'single'
    && singleTrend.json?.total_points === 1
    && singleTrend.json?.series?.[0]?.lines?.[0]?.points?.[0]?.source_available === true
    && singleTrend.json?.series?.[0]?.lines?.[0]?.points?.[0]?.source_page?.bbox?.x === 0.1,
  `${singlePointGroup.text} / ${singleTrend.text}`,
);

const fullTrend = await request(
  'GET', `/api/v1/metric-groups/${metricGroupCreate.json?.id}/trend?limit=100&max_points=100`,
  { token },
);
const serumTrend = fullTrend.json?.series?.find((item: any) => item.selector?.specimen === 'serum'
  && item.selector?.result_kind === 'measured');
const plasmaTrend = fullTrend.json?.series?.find((item: any) => item.selector?.specimen === 'plasma');
const inputTrend = fullTrend.json?.series?.find((item: any) => item.selector?.result_kind === 'input_parameter');
const serumComparable = serumTrend?.lines?.find((line: any) => line.comparable === true);
const serumUnknown = serumTrend?.lines?.find((line: any) => line.comparable === false);
check(
  'P3-2..P3-8 趋势只含确认事实，series/unit/ref/RCV/context/source 边界正确',
  fullTrend.status === 200
    && fullTrend.json?.state === 'trend'
    && fullTrend.json?.total_points === 9
    && serumComparable?.total_points === 6
    && serumUnknown?.total_points === 1
    && plasmaTrend?.lines?.[0]?.total_points === 2
    && inputTrend?.lines?.length === 0
    && serumComparable?.points?.some((point: any) => point.reference?.low === 3.9)
    && serumComparable?.points?.some((point: any) => point.reference?.low === 4)
    && serumComparable?.points?.some((point: any) => point.rcv?.version === 'rcv@1')
    && serumComparable?.points?.every((point: any) => point.source_available === true)
    && plasmaTrend?.lines?.[0]?.points?.some((point: any) => point.fact_source === 'accepted_suggestion')
    && fullTrend.json?.overlays?.some((item: any) => item.kind === 'context_answer')
    && !fullTrend.text.includes('causality'),
  fullTrend.text,
);

const sampledTrend = await request(
  'GET', `/api/v1/metric-groups/${metricGroupCreate.json?.id}/trend?limit=100&max_points=3`,
  { token },
);
const sampledTrendReplay = await request(
  'GET', `/api/v1/metric-groups/${metricGroupCreate.json?.id}/trend?limit=100&max_points=3`,
  { token },
);
const firstTrendPage = await request(
  'GET', `/api/v1/metric-groups/${metricGroupCreate.json?.id}/trend?limit=3&max_points=100`,
  { token },
);
const secondTrendPage = await request(
  'GET', `/api/v1/metric-groups/${metricGroupCreate.json?.id}/trend?limit=3&max_points=100&cursor=${encodeURIComponent(firstTrendPage.json?.next_cursor ?? '')}`,
  { token },
);
const firstIds = new Set((firstTrendPage.json?.series ?? []).flatMap((series: any) => (
  (series.lines ?? []).flatMap((line: any) => line.points ?? []).map((point: any) => point.observation_id)
)));
const secondIds = (secondTrendPage.json?.series ?? []).flatMap((series: any) => (
  (series.lines ?? []).flatMap((line: any) => line.points ?? []).map((point: any) => point.observation_id)
));
check(
  'P3-9 固定 LTTB 与稳定 cursor 分页可重复且不重叠',
  sampledTrend.status === 200
    && sampledTrend.json?.downsampled === true
    && sampledTrend.json?.downsample_version === 'lttb@1'
    && sampledTrend.text === sampledTrendReplay.text
    && firstTrendPage.status === 200
    && typeof firstTrendPage.json?.next_cursor === 'string'
    && secondTrendPage.status === 200
    && secondIds.length > 0
    && secondIds.every((id: string) => !firstIds.has(id)),
  `${sampledTrend.text} / ${firstTrendPage.text} / ${secondTrendPage.text}`,
);

const metricGroups = await request(
  'GET', `/api/v1/people/${person.json.id}/metric-groups`, { token },
);
check(
  'P3-1/P3-10 已归档组默认隐藏，删除 AI L2 后趋势点和已接受来源不变',
  metricGroups.status === 200
    && metricGroups.json?.groups?.length === 2
    && !metricGroups.json?.groups?.some((group: any) => group.id === presetGroup.json?.id)
    && fullTrend.json?.total_points === 9
    && plasmaTrend?.lines?.[0]?.points?.some((point: any) => (
      point.observation_id === acceptedSuggestionObservation?.id
    )),
  `${metricGroups.text} / ${fullTrend.text}`,
);

// ── P4 facts：人工用药、显式事件、稳定来源和 undated（仍完全不需要 AI） ──
const fastingAnswer = labAnswers.json?.answers?.find((answer: any) => (
  answer.question_key === 'fasting_status'
));
const contextPromoteBody = {
  client_operation_id: '018f0000-0000-7000-8000-000000000498',
  confirmed: true,
  target_type: 'observation',
  defaults: { observed_on: '2026-08-27' },
  draft: {
    client_row_id: '018f0000-0000-7000-8000-000000000499',
    local_name: '空腹状态记录', value_raw: '空腹', value_text: '空腹',
  },
};
const contextPromotePreviewOnly = await request(
  'POST', `/api/v1/context/answers/${fastingAnswer?.id}/promote`, {
    token, body: {
      ...contextPromoteBody,
      client_operation_id: '018f0000-0000-7000-8000-000000000497', confirmed: false,
    },
  },
);
const contextPromote = await request(
  'POST', `/api/v1/context/answers/${fastingAnswer?.id}/promote`, {
    token, body: contextPromoteBody,
  },
);
const contextPromoteReplay = await request(
  'POST', `/api/v1/context/answers/${fastingAnswer?.id}/promote`, {
    token, body: contextPromoteBody,
  },
);
check(
  'P1-8 context maps_to 只有预览确认后才显式提升为可恢复 Observation',
  contextPromotePreviewOnly.status === 400
    && contextPromote.status === 200
    && contextPromote.json?.target_type === 'observation'
    && contextPromote.json?.observation?.local_name === '空腹状态记录'
    && contextPromote.json?.observation?.source === 'manual'
    && contextPromote.json?.observation?.source_ref?.context_answer_id === fastingAnswer?.id
    && contextPromote.json?.observation?.source_ref?.promoted_explicitly === true
    && contextPromoteReplay.status === 200
    && contextPromoteReplay.json?.observation?.id === contextPromote.json?.observation?.id,
  `${contextPromotePreviewOnly.text} / ${contextPromote.text} / ${contextPromoteReplay.text}`,
);

const medicationChangeAnswer = sameDayAnswers.json?.answers?.find((answer: any) => (
  answer.question_key === 'medication_changes'
));
const contextMedicationPromoteBody = {
  client_operation_id: '018f0000-0000-7000-8000-000000000494',
  confirmed: true,
  target_type: 'medication',
  draft: {
    client_row_id: '018f0000-0000-7000-8000-000000000495', encounter_id: encounterCreate.json?.id,
    kind: 'prescribed', name_raw: '人工确认的用药调整', generic_name: null,
    dose_raw: null, dose_value: null, dose_unit: null, concentration_pct: null,
    solute_mass_g: null, frequency_raw: '每日一次', route: null,
    administration_group: null, group_volume_ml: null, sequence: null,
    administered_at: null, started_on: '2026-08-27', ended_on: null,
    source_page: null, note: '由上下文答案预填后人工确认',
  },
};
const contextMedicationPromote = await request(
  'POST', `/api/v1/context/answers/${medicationChangeAnswer?.id}/promote`, {
    token, body: contextMedicationPromoteBody,
  },
);
const contextMedicationPromoteReplay = await request(
  'POST', `/api/v1/context/answers/${medicationChangeAnswer?.id}/promote`, {
    token, body: contextMedicationPromoteBody,
  },
);
check(
  'P1-8 context medication_change 只经显式确认提升为可恢复 Medication',
  contextMedicationPromote.status === 200
    && contextMedicationPromote.json?.target_type === 'medication'
    && contextMedicationPromote.json?.medication?.name_raw === '人工确认的用药调整'
    && contextMedicationPromote.json?.medication?.source === 'manual'
    && contextMedicationPromote.json?.medication?.source_ref?.context_answer_id
      === medicationChangeAnswer?.id
    && contextMedicationPromote.json?.medication?.source_ref?.promoted_explicitly === true
    && contextMedicationPromoteReplay.status === 200
    && contextMedicationPromoteReplay.json?.medication?.id
      === contextMedicationPromote.json?.medication?.id,
  `${contextMedicationPromote.text} / ${contextMedicationPromoteReplay.text}`,
);

const medicationBatchBody = {
  client_operation_id: '018f0000-0000-7000-8000-000000000501',
  medications: [
    {
      client_row_id: '018f0000-0000-7000-8000-000000000502', encounter_id: encounterCreate.json?.id,
      kind: 'administered', name_raw: '0.9% 氯化钠注射液', generic_name: '氯化钠',
      dose_raw: '500 mL', dose_value: 500, dose_unit: 'mL', concentration_pct: 0.9,
      solute_mass_g: 4.5, frequency_raw: '一次', route: '静脉滴注',
      administration_group: '急诊输液-1', group_volume_ml: 500, sequence: 1,
      administered_at: '2026-08-27T09:10:00.000Z', started_on: null, ended_on: null,
      source_page: {
        origin_capture_document_id: created.json.id, origin_capture_order: 1,
        object_sha256: sha256, logical_page_index: 1,
        bbox: { x: 0.2, y: 0.3, width: 0.4, height: 0.1 },
      },
      note: '人工核对执行单',
    },
    {
      client_row_id: '018f0000-0000-7000-8000-000000000503', encounter_id: encounterCreate.json?.id,
      kind: 'administered', name_raw: '维生素 C 注射液', generic_name: '抗坏血酸',
      dose_raw: '1 g', dose_value: 1, dose_unit: 'g', concentration_pct: null,
      solute_mass_g: 1, frequency_raw: '一次', route: '静脉滴注',
      administration_group: '急诊输液-1', group_volume_ml: null, sequence: 2,
      administered_at: '2026-08-27T09:12:00.000Z', started_on: null, ended_on: null,
      source_page: null, note: null,
    },
    {
      client_row_id: '018f0000-0000-7000-8000-000000000504', encounter_id: null,
      kind: 'prescribed', name_raw: '阿莫西林胶囊', generic_name: '阿莫西林',
      dose_raw: '0.5 g', dose_value: 0.5, dose_unit: 'g', concentration_pct: null,
      solute_mass_g: null, frequency_raw: '每日三次', route: '口服',
      administration_group: null, group_volume_ml: null, sequence: null,
      administered_at: null, started_on: '2026-08-20', ended_on: '2026-08-26',
      source_page: null, note: '门诊处方',
    },
  ],
};
const medicationBatch = await request(
  'POST', `/api/v1/people/${person.json.id}/medications:batch`, { token, body: medicationBatchBody },
);
const medicationReplay = await request(
  'POST', `/api/v1/people/${person.json.id}/medications:batch`, { token, body: medicationBatchBody },
);
const invalidMedication = await request(
  'POST', `/api/v1/people/${person.json.id}/medications:batch`, {
    token,
    body: {
      ...medicationBatchBody,
      client_operation_id: '018f0000-0000-7000-8000-000000000505',
      medications: [{ ...medicationBatchBody.medications[0],
        client_row_id: '018f0000-0000-7000-8000-000000000506', administered_at: null }],
    },
  },
);
const salineMedication = medicationBatch.json?.medications?.[0];
const vitaminMedication = medicationBatch.json?.medications?.[1];
const prescriptionMedication = medicationBatch.json?.medications?.[2];
check(
  'P4-1 用药 batch 原子保存 prescribed/administered、分组/剂量/时间/稳定来源',
  medicationBatch.status === 201
    && medicationReplay.status === 201
    && medicationReplay.json?.medications?.[0]?.id === salineMedication?.id
    && medicationBatch.json?.medications?.length === 3
    && salineMedication?.canonical_on === '2026-08-27'
    && salineMedication?.time_precision === 'minute'
    && salineMedication?.administration_group === '急诊输液-1'
    && salineMedication?.sequence === 1
    && salineMedication?.source_page?.current_document_id === created.json.id
    && prescriptionMedication?.canonical_on === '2026-08-20'
    && prescriptionMedication?.time_precision === 'date'
    && invalidMedication.status === 400,
  `${medicationBatch.text} / ${medicationReplay.text} / ${invalidMedication.text}`,
);

const medicationPatch = await request('PATCH', `/api/v1/medications/${prescriptionMedication?.id}`, {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000507', if_revision: 1,
    correction_note: '核对处方频次', frequency_raw: '每 8 小时一次',
  },
});
const medicationConflict = await request('PATCH', `/api/v1/medications/${prescriptionMedication?.id}`, {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000508', if_revision: 1,
    correction_note: '过期修改', frequency_raw: '每日一次',
  },
});
const medicationArchive = await request('POST', `/api/v1/medications/${vitaminMedication?.id}/archive`, {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000509', if_revision: 1,
    correction_note: '重复执行记录',
  },
});
const medicationListPage1 = await request(
  'GET', `/api/v1/people/${person.json.id}/medications?from=2026-08-20&to=2026-08-27&limit=1`, { token },
);
const medicationListPage2 = await request(
  'GET', `/api/v1/people/${person.json.id}/medications?from=2026-08-20&to=2026-08-27&limit=1&cursor=${encodeURIComponent(medicationListPage1.json?.next_cursor ?? '')}`,
  { token },
);
const medicationSearch = await request(
  'GET', `/api/v1/search?person_id=${person.json.id}&q=${encodeURIComponent('阿莫西林')}`, { token },
);
check(
  'P4-1 用药修正/冲突/归档/稳定分页/关键词投影完整',
  medicationPatch.status === 200
    && medicationPatch.json?.revision === 2
    && medicationPatch.json?.frequency_raw === '每 8 小时一次'
    && medicationConflict.status === 409
    && medicationConflict.json?.error?.code === 'revision_conflict'
    && medicationArchive.status === 200
    && medicationArchive.json?.archived_at !== null
    && medicationListPage1.status === 200
    && medicationListPage1.json?.medications?.length === 1
    && typeof medicationListPage1.json?.next_cursor === 'string'
    && medicationListPage2.status === 200
    && medicationListPage2.json?.medications?.length === 1
    && medicationListPage1.json?.medications?.[0]?.id !== medicationListPage2.json?.medications?.[0]?.id
    && medicationSearch.json?.results?.some((item: any) => (
      item.entity_type === 'medication' && item.entity_id === prescriptionMedication?.id
    )),
  `${medicationPatch.text} / ${medicationConflict.text} / ${medicationArchive.text}`,
);

const crossPersonMedication = await request(
  'POST', `/api/v1/people/${otherPerson.json.id}/medications:batch`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000510',
      medications: [{
        ...medicationBatchBody.medications[0],
        client_row_id: '018f0000-0000-7000-8000-000000000511', encounter_id: null,
      }],
    },
  },
);
check(
  'P4-1 用药稳定来源跨 person 统一 404',
  crossPersonMedication.status === 404 && crossPersonMedication.json?.error?.code === 'not_found',
  crossPersonMedication.text,
);

const timelineCreateBodies = [
  {
    client_operation_id: '018f0000-0000-7000-8000-000000000512', encounter_id: encounterCreate.json?.id,
    kind: 'procedure', title: '急诊静脉输液', occurred_on: '2026-08-27',
    occurred_at: '2026-08-27T09:10:00.000Z', time_precision: 'minute', note: '人工记录',
    source_page: null,
  },
  {
    client_operation_id: '018f0000-0000-7000-8000-000000000513', encounter_id: null,
    kind: 'symptom', title: '当日发热', occurred_on: '2026-08-27', occurred_at: null,
    time_precision: 'date', note: '仅记录日期，不推断先后', source_page: null,
  },
  {
    client_operation_id: '018f0000-0000-7000-8000-000000000514', encounter_id: null,
    kind: 'other', title: '既往事件日期待确认', occurred_on: null, occurred_at: null,
    time_precision: 'unknown', note: '日期未记录', source_page: null,
  },
];
const timelineCreates: Array<Awaited<ReturnType<typeof request>>> = [];
for (const body of timelineCreateBodies) {
  timelineCreates.push(await request(
    'POST', `/api/v1/people/${person.json.id}/timeline-events`, { token, body },
  ));
}
const invalidTimeline = await request(
  'POST', `/api/v1/people/${person.json.id}/timeline-events`, {
    token, body: { ...timelineCreateBodies[2],
      client_operation_id: '018f0000-0000-7000-8000-000000000515', occurred_on: '2026-08-01' },
  },
);
const timelineReplay = await request(
  'POST', `/api/v1/people/${person.json.id}/timeline-events`, { token, body: timelineCreateBodies[2] },
);
const timelineRangeWithUndated = await request(
  'GET', `/api/v1/people/${person.json.id}/timeline-events?from=2026-08-27&to=2026-08-27&include_undated=true`,
  { token },
);
const timelineRangeDatedOnly = await request(
  'GET', `/api/v1/people/${person.json.id}/timeline-events?from=2026-08-27&to=2026-08-27&include_undated=false`,
  { token },
);
check(
  'P4-2 时间轴精确/仅日期/undated 分区诚实，范围可显式包含未记录日期',
  timelineCreates.every((result) => result.status === 201)
    && timelineCreates[0]?.json?.time_precision === 'minute'
    && timelineCreates[1]?.json?.occurred_at === null
    && timelineCreates[2]?.json?.occurred_on === null
    && timelineReplay.status === 201
    && timelineReplay.json?.id === timelineCreates[2]?.json?.id
    && invalidTimeline.status === 400
    && timelineRangeWithUndated.status === 200
    && timelineRangeWithUndated.json?.events?.length === 3
    && timelineRangeWithUndated.json?.events?.at(-1)?.time_precision === 'unknown'
    && timelineRangeDatedOnly.status === 200
    && timelineRangeDatedOnly.json?.events?.length === 2
    && timelineRangeDatedOnly.json?.events?.every((item: any) => item.occurred_on === '2026-08-27'),
  `${timelineCreates.map((item) => item.text).join(' / ')} / ${timelineRangeWithUndated.text}`,
);

const timelinePatch = await request('PATCH', `/api/v1/timeline-events/${timelineCreates[1]?.json?.id}`, {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000516', if_revision: 1,
    correction_note: '补充症状说明', note: '家属仅确认当日出现发热',
  },
});
const timelineArchive = await request(
  'POST', `/api/v1/timeline-events/${timelineCreates[0]?.json?.id}/archive`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000517', if_revision: 1,
      correction_note: '与用药执行事实重复',
    },
  },
);
const timelineSearch = await request(
  'GET', `/api/v1/search?person_id=${person.json.id}&q=${encodeURIComponent('发热')}`, { token },
);
check(
  'P4-2 时间轴修正/归档/来源检索不从自由文本推断新事实',
  timelinePatch.status === 200
    && timelinePatch.json?.revision === 2
    && timelineArchive.status === 200
    && timelineArchive.json?.archived_at !== null
    && timelineSearch.status === 200
    && timelineSearch.json?.results?.some((item: any) => (
      item.entity_type === 'timeline_event' && item.entity_id === timelineCreates[1]?.json?.id
    )),
  `${timelinePatch.text} / ${timelineArchive.text} / ${timelineSearch.text}`,
);

// ── P4 export：确定性 preview、可恢复 worker、历史/stale 与对象重生 ──
const exportSelection = {
  person_id: person.json.id,
  metric_group_ids: [metricGroupCreate.json?.id, singlePointGroup.json?.id],
  from: '2026-08-20', to: '2026-08-28', include_events: true,
  include_undated_events: true, include_originals: false, format: 'pdf',
};
const exportPreview = await request('POST', '/api/v1/exports/preview', {
  token, body: exportSelection,
});
const oversizedPreview = await request('POST', '/api/v1/exports/preview', {
  token, body: { ...exportSelection, include_originals: true },
});
const oversizedCreate = await request('POST', '/api/v1/exports/visit-summary', {
  token, body: {
    ...exportSelection, include_originals: true,
    client_operation_id: '018f0000-0000-7000-8000-000000000518',
  },
});
check(
  'P4-3/P4-8 预览冻结范围、数量、缺口与原件估算，超限不静默截断',
  exportPreview.status === 200
    && exportPreview.json?.can_generate === true
    && exportPreview.json?.selection?.include_undated_events === true
    && exportPreview.json?.counts?.metric_series >= 2
    && exportPreview.json?.events?.some((item: any) => item.occurred_on === null)
    && oversizedPreview.status === 200
    && oversizedPreview.json?.original_bytes_estimate > 500
    && oversizedPreview.json?.counts?.original_pages === 2
    && oversizedPreview.json?.can_generate === false
    && oversizedCreate.status === 422
    && oversizedCreate.json?.error?.code === 'export_too_large',
  `${exportPreview.text} / ${oversizedPreview.text} / ${oversizedCreate.text}`,
);

const pdfCreateBody = {
  ...exportSelection,
  client_operation_id: '018f0000-0000-7000-8000-000000000519',
};
const pdfCreate = await request('POST', '/api/v1/exports/visit-summary', {
  token, body: pdfCreateBody,
});
const pdfReplay = await request('POST', '/api/v1/exports/visit-summary', {
  token, body: pdfCreateBody,
});
const pdfConflict = await request('POST', '/api/v1/exports/visit-summary', {
  token, body: { ...pdfCreateBody, format: 'png' },
});
const pdfDone = await waitForExport(pdfCreate.json?.id, token);
const pdfDownload = await downloadExport(pdfCreate.json?.id, token);
check(
  'P4-4/P4-5 导出任务幂等生成固定字体 PDF，首屏摘要可下载且 hash 可核对',
  pdfCreate.status === 201
    && pdfReplay.status === 201
    && pdfReplay.json?.id === pdfCreate.json?.id
    && pdfConflict.status === 409
    && pdfDone.status === 200
    && pdfDone.json?.state === 'done'
    && pdfDone.json?.renderer_id === 'medireco-visit-summary'
    && pdfDone.json?.renderer_version === '1.0.0'
    && /^[0-9a-f]{64}$/.test(pdfDone.json?.font_manifest_hash ?? '')
    && pdfDone.json?.artifact_available === true
    && pdfDownload.response.status === 200
    && pdfDownload.response.headers.get('content-type')?.includes('application/pdf') === true
    && pdfDownload.bytes.subarray(0, 4).toString() === '%PDF'
    && pdfDownload.sha256 === pdfDone.json?.result_sha256,
  `${pdfCreate.text} / ${pdfDone.text} / status=${pdfDownload.response.status}`,
);

const pngCreate = await request('POST', '/api/v1/exports/visit-summary', {
  token, body: {
    ...exportSelection, format: 'png',
    client_operation_id: '018f0000-0000-7000-8000-000000000520',
  },
});
const pngDone = await waitForExport(pngCreate.json?.id, token);
const pngDownload = await downloadExport(pngCreate.json?.id, token);
const exportHistory = await request(
  'GET', `/api/v1/people/${person.json.id}/exports`, { token },
);
check(
  'P4-5/P4-9 PNG 确定性生成，完成项可从人物导出历史发现和下载',
  pngCreate.status === 201
    && pngDone.status === 200
    && pngDone.json?.state === 'done'
    && pngDownload.response.status === 200
    && pngDownload.response.headers.get('content-type')?.includes('image/png') === true
    && pngDownload.bytes.subarray(1, 4).toString() === 'PNG'
    && pngDownload.sha256 === pngDone.json?.result_sha256
    && exportHistory.status === 200
    && exportHistory.json?.exports?.some((item: any) => item.id === pdfCreate.json?.id)
    && exportHistory.json?.exports?.some((item: any) => item.id === pngCreate.json?.id),
  `${pngCreate.text} / ${pngDone.text} / ${exportHistory.text}`,
);

const pngStorage = (await sql<{ result_key: string }[]>`
  select result_key from export_job where id = ${pngCreate.json?.id}
`)[0];
if (pngStorage?.result_key) {
  await adminClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: pngStorage.result_key }));
}
const missingPng = await downloadExport(pngCreate.json?.id, token);
const missingPngBody = JSON.parse(missingPng.bytes.toString('utf8'));
const pngRetry = await request('POST', `/api/v1/exports/${pngCreate.json?.id}/retry`, {
  token, body: { client_operation_id: '018f0000-0000-7000-8000-000000000521' },
});
const pngRetryReplay = await request('POST', `/api/v1/exports/${pngCreate.json?.id}/retry`, {
  token, body: { client_operation_id: '018f0000-0000-7000-8000-000000000521' },
});
const pngRegenerated = await waitForExport(pngCreate.json?.id, token);
const pngRegeneratedDownload = await downloadExport(pngCreate.json?.id, token);
check(
  'P4-7 结果对象缺失返回可恢复错误，同一原请求重生后字节 hash 不变',
  missingPng.response.status === 409
    && missingPngBody?.error?.code === 'export_artifact_missing'
    && pngRetry.status === 200
    && pngRetryReplay.status === 200
    && pngRegenerated.json?.state === 'done'
    && pngRegeneratedDownload.response.status === 200
    && pngRegeneratedDownload.sha256 === pngDownload.sha256,
  `${missingPngBody?.error?.code} / ${pngRetry.text} / ${pngRegenerated.text}`,
);

await sql`
  update export_job set state = 'running', attempt = 1, locked_by = 'dead-worker',
    locked_at = now() - interval '10 minutes', lease_expires_at = now() - interval '5 minutes',
    progress = 50, updated_at = now() - interval '5 minutes'
  where id = ${pngCreate.json?.id}
`;
const pngReclaimed = await waitForExport(pngCreate.json?.id, token);
const pngReclaimedDownload = await downloadExport(pngCreate.json?.id, token);
check(
  'P4-6 过期 lease 被回收，worker 崩溃不会让任务永久停在 running',
  pngReclaimed.status === 200
    && pngReclaimed.json?.state === 'done'
    && pngReclaimed.json?.attempt === 2
    && pngReclaimedDownload.sha256 === pngDownload.sha256,
  pngReclaimed.text,
);

const medicationAfterExport = await request(
  'PATCH', `/api/v1/medications/${prescriptionMedication?.id}`, {
    token,
    body: {
      client_operation_id: '018f0000-0000-7000-8000-000000000522', if_revision: 2,
      correction_note: '验证历史导出 stale', note: '处方复核后补充说明',
    },
  },
);
const stalePdf = await request('GET', `/api/v1/exports/${pdfCreate.json?.id}`, { token });
check(
  'P4-7 人工事实修订后历史导出标 stale，既有文件不被静默替换',
  medicationAfterExport.status === 200
    && medicationAfterExport.json?.revision === 3
    && stalePdf.status === 200
    && stalePdf.json?.stale === true
    && stalePdf.json?.result_sha256 === pdfDownload.sha256,
  `${medicationAfterExport.text} / ${stalePdf.text}`,
);

// ── P4 share：owner 显式确认、token 一次返回、公开访问与撤销/过期隔离 ──
const invalidShareExpiry = await request('POST', `/api/v1/exports/${pdfCreate.json?.id}/shares`, {
  token,
  body: {
    client_operation_id: '018f0000-0000-7000-8000-000000000523', expires_in_seconds: 299,
    source_revision_hash: pdfDone.json?.source_revision_hash, confirmed: true,
  },
});
const shareCreateBody = {
  client_operation_id: '018f0000-0000-7000-8000-000000000524', expires_in_seconds: 300,
  source_revision_hash: pdfDone.json?.source_revision_hash, confirmed: true,
};
const shareCreate = await request('POST', `/api/v1/exports/${pdfCreate.json?.id}/shares`, {
  token, body: shareCreateBody,
});
const shareReplay = await request('POST', `/api/v1/exports/${pdfCreate.json?.id}/shares`, {
  token, body: shareCreateBody,
});
const shareConflict = await request('POST', `/api/v1/exports/${pdfCreate.json?.id}/shares`, {
  token, body: { ...shareCreateBody, expires_in_seconds: 301 },
});
const publicShare = await fetch(`${API}/api/v1/shared/exports/${shareCreate.json?.token}`);
const publicShareBytes = Buffer.from(await publicShare.arrayBuffer());
const shareList = await request('GET', `/api/v1/exports/${pdfCreate.json?.id}/shares`, { token });
const shareSecretAudit = (await sql<{
  token_hash: string; request_text: string; result_text: string;
}[]>`
  select es.token_hash, ol.request::text as request_text, ol.result::text as result_text
  from export_share es join operation_ledger ol
    on ol.account_id = es.created_by and ol.client_operation_id = es.client_operation_id
  where es.id = ${shareCreate.json?.share?.id}
`)[0];
check(
  'P4-10 owner 显式确认后只首次返回 256-bit token，重试不可恢复且审计不落明文',
  invalidShareExpiry.status === 400
    && shareCreate.status === 201
    && /^[A-Za-z0-9_-]{43}$/.test(shareCreate.json?.token ?? '')
    && shareCreate.json?.token_recoverable === false
    && shareReplay.status === 201
    && shareReplay.json?.share?.id === shareCreate.json?.share?.id
    && shareReplay.json?.token === null
    && shareReplay.json?.token_recoverable === false
    && shareConflict.status === 409
    && shareSecretAudit !== undefined
    && shareSecretAudit?.token_hash !== shareCreate.json?.token
    && !shareSecretAudit?.request_text.includes(shareCreate.json?.token)
    && !shareSecretAudit?.result_text.includes(shareCreate.json?.token),
  `${invalidShareExpiry.text} / ${shareCreate.text} / ${shareReplay.text} / ${shareConflict.text}`,
);
check(
  'P4-10 公开链接下载不需要账户，响应 no-store 且只暴露通用文件名',
  publicShare.status === 200
    && publicShare.headers.get('cache-control') === 'private, no-store'
    && publicShare.headers.get('content-disposition')?.includes('medireco-shared-summary.pdf') === true
    && !publicShare.headers.get('content-disposition')?.includes(person.json.display_name)
    && publicShareBytes.subarray(0, 4).toString() === '%PDF'
    && shareList.status === 200
    && shareList.json?.shares?.find((item: any) => item.id === shareCreate.json?.share?.id)?.access_count === 1,
  `status=${publicShare.status} / ${shareList.text}`,
);

const expiredShare = await request('POST', `/api/v1/exports/${pdfCreate.json?.id}/shares`, {
  token,
  body: {
    ...shareCreateBody, client_operation_id: '018f0000-0000-7000-8000-000000000525',
  },
});
await sql`update export_share set expires_at = now() - interval '1 second'
  where id = ${expiredShare.json?.share?.id}`;
const expiredPublic = await request(
  'GET', `/api/v1/shared/exports/${expiredShare.json?.token}`,
);
const revokedShare = await request('POST', `/api/v1/exports/${pdfCreate.json?.id}/shares`, {
  token,
  body: {
    ...shareCreateBody, client_operation_id: '018f0000-0000-7000-8000-000000000526',
  },
});
const revokeBody = { client_operation_id: '018f0000-0000-7000-8000-000000000527' };
const revokeShare = await request(
  'DELETE', `/api/v1/exports/${pdfCreate.json?.id}/shares/${revokedShare.json?.share?.id}`,
  { token, body: revokeBody },
);
const revokeReplay = await request(
  'DELETE', `/api/v1/exports/${pdfCreate.json?.id}/shares/${revokedShare.json?.share?.id}`,
  { token, body: revokeBody },
);
const revokedPublic = await request(
  'GET', `/api/v1/shared/exports/${revokedShare.json?.token}`,
);
const unknownPublic = await request(
  'GET', `/api/v1/shared/exports/${Buffer.alloc(32, 9).toString('base64url')}`,
);
check(
  'P4-10 过期、撤销与未知 token 统一 404，撤销自身幂等',
  expiredPublic.status === 404
    && revokedPublic.status === 404
    && unknownPublic.status === 404
    && expiredPublic.text === revokedPublic.text
    && revokedPublic.text === unknownPublic.text
    && revokeShare.status === 200
    && revokeShare.json?.revoked_at !== null
    && revokeReplay.status === 200
    && revokeReplay.json?.id === revokeShare.json?.id,
  `${expiredPublic.text} / ${revokedPublic.text} / ${unknownPublic.text}`,
);

const limitedShare = await request('POST', `/api/v1/exports/${pdfCreate.json?.id}/shares`, {
  token,
  body: {
    ...shareCreateBody, client_operation_id: '018f0000-0000-7000-8000-000000000528',
  },
});
const limitedResponses: Array<Awaited<ReturnType<typeof request>>> = [];
for (let index = 0; index < 11; index += 1) {
  limitedResponses.push(await request(
    'GET', `/api/v1/shared/exports/${limitedShare.json?.token}`,
  ));
}
check(
  'P4-10 公开分享按 token hash/IP 限流且 429 不泄漏资源内容',
  limitedResponses.slice(0, 10).every((response) => response.status === 200)
    && limitedResponses[10]?.status === 429
    && limitedResponses[10]?.json?.error?.code === 'share_rate_limited',
  limitedResponses.map((response) => response.status).join(','),
);

const bundleResponse = await fetch(`${API}/api/v1/exports/person-bundle`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ person_id: person.json.id }),
});
const bundleBytes = Buffer.from(await bundleResponse.arrayBuffer());
if (process.env.CORE_BUNDLE_PATH) writeFileSync(process.env.CORE_BUNDLE_PATH, bundleBytes);
const bundleNames = bundleBytes.toString('latin1');
check(
  'P0-10 单人 L1 bundle 流式生成且隔离其他 person/L2',
  bundleResponse.status === 200
    && bundleResponse.headers.get('content-type')?.includes('application/zip') === true
    && bundleBytes.subarray(0, 2).toString('ascii') === 'PK'
    && bundleNames.includes('bundle-manifest.json')
    && bundleNames.includes(`people/${person.json.slug}/_person.json`)
    && bundleNames.includes(`people/${person.json.slug}/context/${sameDaySessionId}/doctor_advice__${audioMedia.prepare.json?.id}.wav`)
    && bundleNames.includes(`people/${person.json.slug}/context/${sameDaySessionId}/doctor_advice__${audioMedia.prepare.json?.id}.json`)
    && bundleNames.includes('_meta/README.md')
    && !bundleNames.includes(`people/${otherPerson.json.slug}/_person.json`)
    && !bundleNames.includes('derived/'),
  `status=${bundleResponse.status} bytes=${bundleBytes.length}`,
);

const rerun = await request('POST', `/api/v1/documents/${created.json.id}/ai/rerun`, {
  token, body: { kind: 'stage1' },
});
check(
  'C0-2 off 显式辅助重跑返回 capability_unavailable',
  rerun.status === 503 && rerun.json?.error?.code === 'capability_unavailable',
  rerun.text,
);

const outsider = await request('POST', '/api/v1/auth/register', {
  body: {
    email: 'core-outsider@local.test',
    password: 'core-outsider-password',
    display_name: 'Core 无权账户',
    birth_date: '1995-05-05',
    sex_at_birth: 'unknown',
    timezone: 'Asia/Shanghai',
  },
});
const outsiderSearch = await request(
  'GET', `/api/v1/search?person_id=${person.json.id}&q=${encodeURIComponent('血脂')}`,
  { token: outsider.json?.access_token },
);
const outsiderDetail = await request('GET', `/api/v1/documents/${created.json.id}`, {
  token: outsider.json?.access_token,
});
const outsiderBundle = await request('POST', '/api/v1/exports/person-bundle', {
  token: outsider.json?.access_token,
  body: { person_id: person.json.id },
});
const outsiderContext = await request(
  'GET', `/api/v1/context/sessions/${sameDaySessionId}`, { token: outsider.json?.access_token },
);
const outsiderContextMedia = await request(
  'GET', `/api/v1/context/uploads/${audioMedia.prepare.json?.id}`, { token: outsider.json?.access_token },
);
const outsiderObservations = await request(
  'GET', `/api/v1/people/${person.json.id}/observations`, { token: outsider.json?.access_token },
);
const outsiderMedications = await request(
  'GET', `/api/v1/people/${person.json.id}/medications`, { token: outsider.json?.access_token },
);
const outsiderTimeline = await request(
  'GET', `/api/v1/people/${person.json.id}/timeline-events`, { token: outsider.json?.access_token },
);
const outsiderExport = await request(
  'GET', `/api/v1/exports/${pdfCreate.json?.id}`, { token: outsider.json?.access_token },
);
check(
  'P0-8/P1-7/P2-8/P4-9 无权 search/detail/bundle/context/media/facts 统一 404',
  outsider.status === 201
    && outsiderSearch.status === 404
    && outsiderDetail.status === 404
    && outsiderBundle.status === 404
    && outsiderContext.status === 404
    && outsiderContextMedia.status === 404
    && outsiderObservations.status === 404
    && outsiderMedications.status === 404
    && outsiderTimeline.status === 404
    && outsiderExport.status === 404,
  `${outsider.text} / ${outsiderSearch.text} / ${outsiderDetail.text} / ${outsiderBundle.text} / ${outsiderContext.text} / ${outsiderContextMedia.text} / ${outsiderObservations.text} / ${outsiderMedications.text} / ${outsiderTimeline.text} / ${outsiderExport.text}`,
);

const outsiderAccount = (await sql<{ id: string }[]>`
  select id from account where email = 'core-outsider@local.test'
`)[0];
if (!outsiderAccount) throw new Error('core outsider account was not persisted');
await sql`
  insert into person_access (account_id, person_id, role)
  values (${outsiderAccount.id}, ${person.json.id}, 'editor')
  on conflict (account_id, person_id) do update set role = excluded.role
`;
const editorShare = await request('POST', `/api/v1/exports/${pdfCreate.json?.id}/shares`, {
  token: outsider.json?.access_token,
  body: {
    ...shareCreateBody, client_operation_id: '018f0000-0000-7000-8000-000000000529',
  },
});
const editorExport = await request('POST', '/api/v1/exports/visit-summary', {
  token: outsider.json?.access_token,
  body: {
    ...exportSelection, format: 'png',
    client_operation_id: '018f0000-0000-7000-8000-000000000530',
  },
});
const editorExportDone = await waitForExport(editorExport.json?.id, outsider.json?.access_token);
await sql`update person_access set role = 'viewer'
  where account_id = ${outsiderAccount.id} and person_id = ${person.json.id}`;
const viewerHistory = await request(
  'GET', `/api/v1/people/${person.json.id}/exports`, { token: outsider.json?.access_token },
);
const viewerCreate = await request('POST', '/api/v1/exports/visit-summary', {
  token: outsider.json?.access_token,
  body: {
    ...exportSelection, format: 'png',
    client_operation_id: '018f0000-0000-7000-8000-000000000531',
  },
});
const viewerShares = await request(
  'GET', `/api/v1/exports/${pdfCreate.json?.id}/shares`, { token: outsider.json?.access_token },
);
check(
  'P4-9 editor 可生成但不能公开分享；viewer 只读完成历史且不能生成/查看分享',
  outsiderAccount !== undefined
    && editorShare.status === 404
    && editorExport.status === 201
    && editorExportDone.status === 200
    && editorExportDone.json?.state === 'done'
    && viewerHistory.status === 200
    && viewerHistory.json?.exports?.length === 3
    && viewerHistory.json?.exports?.every((item: any) => item.state === 'done')
    && viewerCreate.status === 404
    && viewerShares.status === 404,
  `${editorShare.text} / ${editorExport.text} / ${viewerHistory.text} / ${viewerCreate.text} / ${viewerShares.text}`,
);

const counts = (await sql`
  select
    (select count(*)::int from ai_job) as legacy_jobs,
    (select count(*)::int from processing_job) as processing_jobs,
    (select count(*)::int from processing_plugin) as plugins,
    (select count(*)::int from document_manual_metadata) as manual_metadata,
    (select count(*)::int from operation_ledger where kind = 'document_metadata_upsert') as fact_ledger,
    (select count(*)::int from operation_ledger where kind like 'encounter_%') as encounter_ledger,
    (select count(*)::int from search_entry where entity_type = 'document') as search_entries,
    (select count(*)::int from search_entry where entity_type = 'encounter') as encounter_search_entries,
    (select count(*)::int from context_session) as context_sessions,
    (select count(*)::int from context_answer) as context_answers,
    (select count(*)::int from context_upload where state = 'finalized') as context_uploads,
    (select count(distinct answer_type)::int from context_answer) as context_answer_types,
    (select count(*)::int from search_entry where entity_type = 'context_answer') as context_search_entries,
    (select count(*)::int from operation_ledger where kind = 'context_session_upsert') as context_session_ledger,
    (select count(*)::int from operation_ledger where kind = 'context_answer_upsert') as context_answer_ledger,
    (select count(*)::int from operation_ledger where kind = 'context_media_finalize') as context_media_ledger,
    (select count(*)::int from observation) as observations,
    (select count(*)::int from observation where archived_at is null) as active_observations,
    (select count(*)::int from concept_alias_decision where state = 'confirmed') as concept_aliases,
    (select count(*)::int from search_entry where entity_type = 'observation') as observation_search_entries,
    (select count(*)::int from operation_ledger where kind = 'observation_upsert') as observation_ledger,
    (select count(*)::int from operation_ledger where kind = 'concept_alias_upsert') as concept_alias_ledger,
    (select count(*)::int from metric_group) as metric_groups,
    (select count(*)::int from metric_group_item) as metric_group_items,
    (select count(*)::int from operation_ledger where kind like 'metric_group_%') as metric_group_ledger,
    (select count(*)::int from medication) as medications,
    (select count(*)::int from medication where archived_at is null) as active_medications,
    (select count(*)::int from timeline_event) as timeline_events,
    (select count(*)::int from timeline_event where archived_at is null) as active_timeline_events,
    (select count(*)::int from operation_ledger where kind = 'medication_upsert') as medication_ledger,
    (select count(*)::int from operation_ledger where kind = 'timeline_event_upsert') as timeline_ledger,
    (select count(*)::int from search_entry where entity_type = 'medication') as medication_search_entries,
    (select count(*)::int from search_entry where entity_type = 'timeline_event') as timeline_search_entries,
    (select count(*)::int from export_job where state = 'done') as done_exports,
    (select count(*)::int from operation_ledger where kind = 'export_create') as export_create_ledger,
    (select count(*)::int from operation_ledger where kind = 'export_retry') as export_retry_ledger,
    (select count(*)::int from export_share) as export_shares,
    (select count(*)::int from operation_ledger where kind = 'export_share_create') as share_create_ledger,
    (select count(*)::int from operation_ledger where kind = 'export_share_revoke') as share_revoke_ledger
`)[0]!;
await sql.end();
check(
  'C0-2 off 不创建旧/新处理作业且无插件心跳',
  counts['legacy_jobs'] === 0 && counts['processing_jobs'] === 0 && counts['plugins'] === 0,
  JSON.stringify(counts),
);
check(
  'P3-1 监控组/items/ledger 人工层全部落盘',
  counts['metric_groups'] === 3
    && counts['metric_group_items'] === 14
    && counts['metric_group_ledger'] === 5,
  JSON.stringify(counts),
);
check(
  'P4-1/P4-2 用药与时间轴事实、ledger、搜索投影全部落盘',
  counts['medications'] === 4
    && counts['active_medications'] === 3
    && counts['timeline_events'] === 3
    && counts['active_timeline_events'] === 2
    && counts['medication_ledger'] === 5
    && counts['timeline_ledger'] === 5
    && counts['medication_search_entries'] === 3
    && counts['timeline_search_entries'] === 2,
  JSON.stringify(counts),
);
check(
  'P4-3..P4-9 导出 job 与 L2 幂等审计全部落盘',
  counts['done_exports'] === 3
    && counts['export_create_ledger'] === 3
    && counts['export_retry_ledger'] === 1
    && counts['export_shares'] === 4
    && counts['share_create_ledger'] === 4
    && counts['share_revoke_ledger'] === 1,
  JSON.stringify(counts),
);
check(
  'P0-1 人工事实同步写入 metadata/ledger/search projection',
  counts['manual_metadata'] === 1 && counts['fact_ledger'] === 4 && counts['search_entries'] === 2,
  JSON.stringify(counts),
);
check(
  'P0-4 encounter 事实同步写入 ledger/search projection',
  counts['encounter_ledger'] === 6 && counts['encounter_search_entries'] === 2,
  JSON.stringify(counts),
);
check(
  'P1-4/P1-9 八类答案、媒体、搜索与可重放 operation 全部落盘',
  counts['context_sessions'] === 4
    && counts['context_answers'] === 16
    && counts['context_uploads'] === 2
    && counts['context_answer_types'] === 8
    && counts['context_search_entries'] === 13
    && counts['context_session_ledger'] === 9
    && counts['context_answer_ledger'] === 4
    && counts['context_media_ledger'] === 2,
  JSON.stringify(counts),
);
check(
  'P2-1/P2-5/P2-6 Observation/alias/ledger/search 人工层全部落盘',
  counts['observations'] === 15
    && counts['active_observations'] === 14
    && counts['concept_aliases'] === 1
    && counts['observation_search_entries'] === 14
    && counts['observation_ledger'] === 7
    && counts['concept_alias_ledger'] === 1,
  JSON.stringify(counts),
);

const history = await request('GET', '/api/v1/normalization-decisions', { token });
check('C0-3 off 仍可访问历史人工审核入口', history.status === 200, history.text);

console.log(`Core-0 acceptance: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
