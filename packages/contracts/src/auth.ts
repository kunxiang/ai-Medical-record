import { z } from 'zod';
import { IsoDate } from './scalars.js';
import { SexAtBirth } from './enums.js';

const IanaTimezone = z.string().trim().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, '不是有效的 IANA 时区');

export const LoginRequest = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(255),
});
export const LoginResponse = z.object({ access_token: z.string() });

export const AccountProfile = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  display_name: z.string(),
  timezone: IanaTimezone,
  created_at: z.string().datetime({ offset: true }),
});

export const DeleteAccountRequest = z.object({
  current_password: z.string().min(1).max(255),
  confirmation: z.literal('DELETE'),
});

export const DeleteAccountResponse = z.object({ deleted: z.literal(true) });

export const RegisterRequest = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(12).max(128),
  display_name: z.string().trim().min(1).max(64),
  birth_date: IsoDate.refine((value) => value <= new Date().toISOString().slice(0, 10), '出生日期不能晚于今天'),
  sex_at_birth: SexAtBirth.default('unknown'),
  timezone: IanaTimezone.default('Asia/Shanghai'),
});

export type LoginResponseT = z.infer<typeof LoginResponse>;
export type AccountProfileT = z.infer<typeof AccountProfile>;
export type DeleteAccountRequestT = z.infer<typeof DeleteAccountRequest>;
export type RegisterRequestT = z.infer<typeof RegisterRequest>;
