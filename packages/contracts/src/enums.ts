import { z } from 'zod';

// spec m0-01 §2 —— 唯一定义源:DB CHECK 与 API 文档由此生成
export const SexAtBirth = z.enum(['male', 'female', 'unknown']);
export const RelationToOwner = z.enum(['self', 'spouse', 'parent', 'child', 'sibling', 'other']);
export const IdentifierType = z.enum(['patient_id', 'card_no', 'medical_record_no', 'other']);
export const IdentifierScope = z.enum(['long_term', 'single_visit']);
export const AccessRole = z.enum(['owner', 'editor', 'viewer']);
export type AccessRoleT = z.infer<typeof AccessRole>;
// `split` 是服务端边界纠正产生的合成来源；上传登记接口会显式拒绝客户端提交该值。
export const DocumentSource = z.enum(['camera', 'album', 'pdf', 'screenshot', 'scan', 'import', 'split']);
export const DocumentStatus = z.enum([
  'uploading', 'uploaded', 'needs_person_confirm', 'ready', 'failed',
]);
export const EncounterType = z.enum(['outpatient', 'inpatient', 'emergency', 'checkup', 'other']);
// 匹配规则:精确小写;带参数或大小写变体 → 422 unsupported_media_type
export const MimeType = z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
export const DocType = z.enum([
  'lab_report', 'imaging_report', 'prescription', 'discharge_summary',
  'pathology', 'outpatient_note', 'checkup_report', 'ecg',
  'vaccination', 'infusion_order', 'other', 'unknown',
]);

export const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
} as const satisfies Record<z.infer<typeof MimeType>, string>;

// m2-01 §2:归人对账的比对结果。**没有 skipped** —— 人工 ack 写的是
// document.person_check_ack_at(L1),不是这一列(L2,每次 S1 重跑都会被覆盖)。
// 一列同时承载模型与人的判断,重跑时模型会赢(审核 #004 A-5)。
export const PersonCheck = z.enum(['match', 'mismatch', 'unknown']);
export type PersonCheckT = import('zod').infer<typeof PersonCheck>;
