import { useState } from 'react';
import { api } from '../../api/client.js';

export function LoginView({ onLoggedIn, notice }: { onLoggedIn: (token: string) => void; notice: string | null }): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="login"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        api.login(email, password)
          .then((r) => onLoggedIn(r.access_token))
          .catch(() => setError('登录失败,请检查邮箱与密码'))
          .finally(() => setBusy(false));
      }}
    >
      <h1>AI 病历</h1>
      {notice && <p className="banner warn">{notice}</p>}
      <input type="email" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)}
             data-testid="login-email" autoComplete="username" required />
      <input type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)}
             data-testid="login-password" autoComplete="current-password" required />
      <button type="submit" disabled={busy} data-testid="login-submit">{busy ? '登录中…' : '登录'}</button>
      {error && <p className="error" data-testid="login-error">{error}</p>}
    </form>
  );
}
