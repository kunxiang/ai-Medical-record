import { describe, expect, it } from 'vitest';
import { AccountProfile, DeleteAccountRequest, LoginRequest, RegisterRequest } from '../src/auth.js';

const validRegistration = {
  email: ' New.User@Example.COM ',
  password: 'correct horse battery staple',
  display_name: ' 张三 ',
  birth_date: '1990-06-18',
  sex_at_birth: 'unknown' as const,
  timezone: 'Asia/Shanghai',
};

describe('auth contracts', () => {
  it('注册时规范化邮箱和姓名', () => {
    const parsed = RegisterRequest.parse(validRegistration);
    expect(parsed.email).toBe('new.user@example.com');
    expect(parsed.display_name).toBe('张三');
  });

  it('拒绝弱密码、未来出生日期和无效时区', () => {
    expect(RegisterRequest.safeParse({ ...validRegistration, password: 'too-short' }).success).toBe(false);
    expect(RegisterRequest.safeParse({ ...validRegistration, birth_date: '2999-01-01' }).success).toBe(false);
    expect(RegisterRequest.safeParse({ ...validRegistration, timezone: 'Mars/Olympus' }).success).toBe(false);
  });

  it('登录邮箱也使用与注册一致的规范化规则', () => {
    expect(LoginRequest.parse({ email: ' User@Example.COM ', password: 'secret' }).email).toBe('user@example.com');
  });

  it('账户信息包含只读的身份与注册时间', () => {
    expect(AccountProfile.parse({
      id: '018f2f8c-6a30-7a12-8c8a-4efb64ea2401',
      email: 'user@example.com',
      display_name: '张三',
      timezone: 'Asia/Shanghai',
      created_at: '2026-08-26T04:00:00.000Z',
    }).display_name).toBe('张三');
  });

  it('注销账户必须提交当前密码和明确确认值', () => {
    expect(DeleteAccountRequest.safeParse({ current_password: 'secret', confirmation: 'DELETE' }).success).toBe(true);
    expect(DeleteAccountRequest.safeParse({ current_password: 'secret', confirmation: 'delete' }).success).toBe(false);
  });
});
