import { useState } from 'react';
import {
  ArrowRight, AtSign, CalendarDays, Cloud, FileCheck2, LoaderCircle, LockKeyhole,
  ShieldCheck, UserRound,
} from 'lucide-react';
import { api, ApiFailure } from '../../api/client.js';
import { BrandMark } from '../../ui/BrandMark.js';
import { Button } from '../../ui/Button.js';
import { Field } from '../../ui/Field.js';
import { Input } from '../../ui/Input.js';
import { Select } from '../../ui/Select.js';
import { Alert } from '../../ui/Alert.js';
import { cn } from '../../ui/cn.js';

type AuthMode = 'login' | 'register';

function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function LoginView({
  onLoggedIn,
  notice,
}: {
  onLoggedIn: (token: string) => void;
  notice: string | null;
}): JSX.Element {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [sexAtBirth, setSexAtBirth] = useState<'male' | 'female' | 'unknown'>('unknown');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError(null);
  };

  const submit = async () => {
    if (mode === 'register' && password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'login'
          ? await api.login(email, password)
          : await api.register({
              email,
              password,
              display_name: displayName,
              birth_date: birthDate,
              sex_at_birth: sexAtBirth,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
            });
      onLoggedIn(result.access_token);
    } catch (cause) {
      if (mode === 'register' && cause instanceof ApiFailure) {
        if (cause.code === 'email_already_registered') {
          setError('该邮箱已注册,请切换到登录');
        } else if (cause.code === 'rate_limited') {
          setError('注册尝试过于频繁,请稍后再试');
        } else if (cause.code === 'validation_failed') {
          setError('请检查姓名、出生日期和密码是否符合要求');
        } else {
          setError('注册失败,请稍后重试');
        }
      } else {
        setError('登录失败,请检查邮箱与密码');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="relative min-h-screen flex items-center justify-center p-4 sm:p-6 md:p-10 bg-background overflow-hidden font-sans">
      {/* Gentle ambient background gradients */}
      <div
        className="pointer-events-none absolute -top-40 -left-40 w-96 h-96 rounded-full bg-brand-200/40 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-40 -right-40 w-96 h-96 rounded-full bg-brand-300/30 blur-3xl"
        aria-hidden="true"
      />

      <div className="relative z-10 w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
        {/* Left Side: Brand Story & Trust Props */}
        <div className="lg:col-span-6 flex flex-col justify-center space-y-6 lg:py-6">
          <BrandMark />

          <div className="space-y-3">
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold bg-brand-50 text-brand-700 border border-brand-200/60 tracking-wide">
              你的家庭健康记忆
            </span>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black text-ink tracking-tight leading-[1.15]">
              让每一份病历，
              <br />
              <span className="text-brand-600">都能在需要时被找到。</span>
            </h1>
            <p className="text-sm sm:text-base text-muted leading-relaxed max-w-lg">
              拍照即归档，原件安全保存。多年之后，仍然清楚知道它属于谁、来自哪里、发生在何时。
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-1 gap-3 pt-2">
            <div className="flex items-center gap-3 p-3 rounded-xl bg-white/70 backdrop-blur-xs border border-line/70 shadow-2xs">
              <div className="w-8 h-8 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
                <FileCheck2 size={18} />
              </div>
              <span className="text-xs font-semibold text-ink-secondary">原始文件零改动保存</span>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-xl bg-white/70 backdrop-blur-xs border border-line/70 shadow-2xs">
              <div className="w-8 h-8 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
                <Cloud size={18} />
              </div>
              <span className="text-xs font-semibold text-ink-secondary">弱网下先保存，联网后再上传</span>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-xl bg-white/70 backdrop-blur-xs border border-line/70 shadow-2xs">
              <div className="w-8 h-8 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
                <ShieldCheck size={18} />
              </div>
              <span className="text-xs font-semibold text-ink-secondary">家庭成员档案独立管理</span>
            </div>
          </div>

          <p className="text-xs text-subtle/80 flex items-center gap-1.5 pt-1">
            <span>🛡️ MediReco 只帮助整理与呈现记录，不提供医学诊断。</span>
          </p>
        </div>

        {/* Right Side: Auth Card Form */}
        <div className="lg:col-span-6 w-full max-w-md mx-auto">
          <div className="bg-white/95 backdrop-blur-md rounded-3xl p-6 sm:p-8 shadow-soft border border-line/80">
            {/* Tab switch */}
            <div
              className="flex p-1 mb-6 rounded-2xl bg-surface-subtle border border-line/70"
              aria-label="登录或注册"
            >
              <button
                type="button"
                onClick={() => switchMode('login')}
                className={cn(
                  'flex-1 py-2.5 rounded-xl text-sm font-bold transition-all duration-150 cursor-pointer text-center',
                  mode === 'login'
                    ? 'bg-white text-ink shadow-xs'
                    : 'text-muted hover:text-ink',
                )}
              >
                登录
              </button>
              <button
                type="button"
                onClick={() => switchMode('register')}
                className={cn(
                  'flex-1 py-2.5 rounded-xl text-sm font-bold transition-all duration-150 cursor-pointer text-center',
                  mode === 'register'
                    ? 'bg-white text-ink shadow-xs'
                    : 'text-muted hover:text-ink',
                )}
              >
                创建账号
              </button>
            </div>

            <div className="space-y-1 mb-6">
              <h2 className="text-xl font-bold text-ink tracking-tight">
                {mode === 'login' ? '登录你的健康档案' : '创建你的 MediReco 账号'}
              </h2>
              <p className="text-xs text-muted">
                {mode === 'login'
                  ? '继续采集、整理和查看家庭病历。'
                  : '注册后会自动建立你的本人档案。'}
              </p>
            </div>

            {notice && (
              <Alert variant="warning" className="mb-5" data-testid="notice">
                {notice}
              </Alert>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              className="space-y-4"
            >
              {mode === 'register' && (
                <Field label="姓名" required>
                  <Input
                    iconLeft={<UserRound size={17} />}
                    type="text"
                    placeholder="用于本人健康档案"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    data-testid="register-name"
                    autoComplete="name"
                    maxLength={64}
                    required
                  />
                </Field>
              )}

              <Field label="邮箱地址" required>
                <Input
                  iconLeft={<AtSign size={17} />}
                  type="email"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid={mode === 'login' ? 'login-email' : 'register-email'}
                  autoComplete="email"
                  maxLength={255}
                  required
                />
              </Field>

              {mode === 'register' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <Field label="出生日期" required>
                    <Input
                      iconLeft={<CalendarDays size={17} />}
                      type="date"
                      value={birthDate}
                      onChange={(e) => setBirthDate(e.target.value)}
                      data-testid="register-birth-date"
                      autoComplete="bday"
                      max={localToday()}
                      required
                    />
                  </Field>
                  <Field label="出生时性别">
                    <Select
                      iconLeft={<UserRound size={17} />}
                      value={sexAtBirth}
                      onChange={(e) => setSexAtBirth(e.target.value as typeof sexAtBirth)}
                      data-testid="register-sex-at-birth"
                    >
                      <option value="unknown">暂不填写</option>
                      <option value="female">女</option>
                      <option value="male">男</option>
                    </Select>
                  </Field>
                </div>
              )}

              <Field label="密码" required>
                <Input
                  iconLeft={<LockKeyhole size={17} />}
                  type="password"
                  placeholder={mode === 'register' ? '至少 12 位长密码' : '输入密码'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid={mode === 'login' ? 'login-password' : 'register-password'}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  minLength={mode === 'register' ? 12 : 1}
                  maxLength={mode === 'register' ? 128 : 255}
                  required
                />
              </Field>

              {mode === 'register' && (
                <Field
                  label="确认密码"
                  required
                  hint="建议使用易记的长密码，不需要特殊字符组合。"
                >
                  <Input
                    iconLeft={<LockKeyhole size={17} />}
                    type="password"
                    placeholder="再次输入密码"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    data-testid="register-password-confirm"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={128}
                    required
                  />
                </Field>
              )}

              {error && (
                <Alert
                  variant="danger"
                  className="mt-3"
                  data-testid={mode === 'login' ? 'login-error' : 'register-error'}
                >
                  {error}
                </Alert>
              )}

              <Button
                variant="primary"
                size="lg"
                fullWidth
                type="submit"
                loading={busy}
                iconRight={!busy ? <ArrowRight size={18} /> : undefined}
                data-testid={mode === 'login' ? 'login-submit' : 'register-submit'}
                className="mt-5 rounded-2xl shadow-brand"
              >
                {mode === 'login' ? '安全登录' : '创建并进入档案'}
              </Button>

              <div className="pt-2 text-center">
                <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                  <ShieldCheck size={14} className="text-brand-600" /> 登录凭证通过加密连接发送
                </span>
              </div>
            </form>
          </div>
        </div>
      </div>
    </main>
  );
}
