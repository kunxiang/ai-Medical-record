import { useState } from 'react';
import {
  ArrowRight, AtSign, CalendarDays, Cloud, FileCheck2, LoaderCircle, LockKeyhole,
  ShieldCheck, UserRound,
} from 'lucide-react';
import { api, ApiFailure } from '../../api/client.js';
import { BrandMark } from '../../ui/BrandMark.js';

type AuthMode = 'login' | 'register';

function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function LoginView({ onLoggedIn, notice }: { onLoggedIn: (token: string) => void; notice: string | null }): JSX.Element {
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
      const result = mode === 'login'
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
    <main className="login-page">
      <div className="login-ambient ambient-one" />
      <div className="login-ambient ambient-two" />
      <section className="login-shell">
        <div className="login-story">
          <BrandMark />
          <div className="login-story-copy">
            <span className="eyebrow light">你的家庭健康记忆</span>
            <h1>让每一份病历，<br />都能在需要时被找到。</h1>
            <p>拍照即归档，原件安全保存。多年之后，仍然清楚知道它属于谁、来自哪里、发生在何时。</p>
          </div>
          <div className="trust-list">
            <span><FileCheck2 /> 原始文件零改动保存</span>
            <span><Cloud /> 弱网下先保存，联网后再上传</span>
            <span><ShieldCheck /> 家庭成员档案独立管理</span>
          </div>
          <p className="login-story-note">MediReco 只帮助整理与呈现记录，不提供医学诊断。</p>
        </div>
        <form
          className={`login-card ${mode === 'register' ? 'register-mode' : ''}`}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="auth-switch" aria-label="登录或注册">
            <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => switchMode('login')}>登录</button>
            <button type="button" className={mode === 'register' ? 'on' : ''} onClick={() => switchMode('register')}>创建账号</button>
          </div>
          <div className="login-card-heading">
            <span className="eyebrow">{mode === 'login' ? '欢迎回来' : '开始建立健康档案'}</span>
            <h2>{mode === 'login' ? '登录你的健康档案' : '创建你的 MediReco 账号'}</h2>
            <p>{mode === 'login' ? '继续采集、整理和查看家庭病历。' : '注册后会自动建立你的本人档案。'}</p>
          </div>
          {notice && <p className="banner warn">{notice}</p>}

          {mode === 'register' && (
            <label className="field-label">
              <span>姓名</span>
              <span className="input-shell">
                <UserRound size={19} aria-hidden="true" />
                <input type="text" placeholder="用于本人健康档案" value={displayName}
                       onChange={(event) => setDisplayName(event.target.value)} data-testid="register-name"
                       autoComplete="name" maxLength={64} required />
              </span>
            </label>
          )}

          <label className="field-label">
            <span>邮箱地址</span>
            <span className="input-shell">
              <AtSign size={19} aria-hidden="true" />
              <input type="email" placeholder="name@example.com" value={email}
                     onChange={(event) => setEmail(event.target.value)}
                     data-testid={mode === 'login' ? 'login-email' : 'register-email'}
                     autoComplete="email" maxLength={255} required />
            </span>
          </label>

          {mode === 'register' && (
            <div className="register-grid">
              <label className="field-label">
                <span>出生日期</span>
                <span className="input-shell">
                  <CalendarDays size={19} aria-hidden="true" />
                  <input type="date" value={birthDate} onChange={(event) => setBirthDate(event.target.value)}
                         data-testid="register-birth-date" autoComplete="bday" max={localToday()} required />
                </span>
              </label>
              <label className="field-label">
                <span>出生时性别</span>
                <span className="input-shell">
                  <UserRound size={19} aria-hidden="true" />
                  <select value={sexAtBirth} onChange={(event) => setSexAtBirth(event.target.value as typeof sexAtBirth)}
                          data-testid="register-sex-at-birth">
                    <option value="unknown">暂不填写</option>
                    <option value="female">女</option>
                    <option value="male">男</option>
                  </select>
                </span>
              </label>
            </div>
          )}

          <label className="field-label">
            <span>密码</span>
            <span className="input-shell">
              <LockKeyhole size={19} aria-hidden="true" />
              <input type="password" placeholder={mode === 'register' ? '至少 12 位' : '输入密码'} value={password}
                     onChange={(event) => setPassword(event.target.value)}
                     data-testid={mode === 'login' ? 'login-password' : 'register-password'}
                     autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                     minLength={mode === 'register' ? 12 : 1} maxLength={mode === 'register' ? 128 : 255} required />
            </span>
          </label>

          {mode === 'register' && (
            <label className="field-label">
              <span>确认密码</span>
              <span className="input-shell">
                <LockKeyhole size={19} aria-hidden="true" />
                <input type="password" placeholder="再次输入密码" value={confirmPassword}
                       onChange={(event) => setConfirmPassword(event.target.value)}
                       data-testid="register-password-confirm" autoComplete="new-password"
                       minLength={12} maxLength={128} required />
              </span>
              <small className="password-hint">建议使用易记的长密码，不需要特殊字符组合。</small>
            </label>
          )}

          <button className="login-submit" type="submit" disabled={busy}
                  data-testid={mode === 'login' ? 'login-submit' : 'register-submit'}>
            {busy ? (
              <><LoaderCircle className="spin" size={19} /> {mode === 'login' ? '登录中…' : '正在创建…'}</>
            ) : (
              <>{mode === 'login' ? '安全登录' : '创建并进入档案'} <ArrowRight size={19} /></>
            )}
          </button>
          {error && (
            <p className="error login-error" data-testid={mode === 'login' ? 'login-error' : 'register-error'}>{error}</p>
          )}
          <p className="login-privacy"><ShieldCheck size={15} /> 登录凭证通过加密连接发送</p>
        </form>
      </section>
    </main>
  );
}
