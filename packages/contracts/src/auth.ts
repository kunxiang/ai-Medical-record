import { z } from 'zod';

export const LoginRequest = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(255),
});
export const LoginResponse = z.object({ access_token: z.string() });

export type LoginResponseT = z.infer<typeof LoginResponse>;
