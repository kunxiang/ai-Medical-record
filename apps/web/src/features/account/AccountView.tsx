import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CalendarDays, CircleUserRound, Clock3, KeyRound, LoaderCircle, LogOut, Mail,
  ShieldCheck, Trash2, TriangleAlert, X,
} from 'lucide-react';
import type { AccountProfileT } from '@amr/contracts';
import { api, ApiFailure } from '../../api/client.js';

function formatCreatedAt(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

export function AccountView({
  queuedItemCount, onLogout, onDeleteAccount,
}: {
  queuedItemCount: number;
  onLogout: () => void;
  onDeleteAccount: (password: string) => Promise<void>;
}): JSX.Element {
  const [profile, setProfile] = useState<AccountProfileT | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.account().then(
      (value) => { if (!cancelled) setProfile(value); },
      () => { if (!cancelled) setLoadError('账户信息暂时无法加载，请检查网络后重试。'); },
    );
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!deleteOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleting) setDeleteOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [deleteOpen, deleting]);

  const closeDelete = () => {
    if (deleting) return;
    setDeleteOpen(false);
    setPassword('');
    setUnderstood(false);
    setDeleteError(null);
  };

  const submitDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteAccount(password);
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.code === 'unauthenticated') {
        setDeleteError('当前密码不正确，请重新输入。');
      } else {
        setDeleteError('账户注销失败，请检查网络后重试。');
      }
      setDeleting(false);
    }
  };

  return (
    <div className="page-view account-view">
      <div className="page-heading account-heading">
        <div>
          <span className="eyebrow">账户与隐私</span>
          <h1>账户中心</h1>
          <p>查看登录身份、管理当前会话，并控制账户访问权限。</p>
        </div>
        <span className="security-pill"><ShieldCheck size={17} /> 登录信息受保护</span>
      </div>

      <section className="surface account-profile-card" aria-labelledby="account-profile-title">
        <div className="account-profile-hero">
          <span className="account-avatar"><CircleUserRound size={34} /></span>
          <div>
            <small>当前账户</small>
            <h2 id="account-profile-title">{profile?.display_name ?? '正在加载…'}</h2>
            <p>{profile?.email ?? '读取账户信息'}</p>
          </div>
        </div>

        {loadError ? (
          <div className="banner warn account-load-error"><TriangleAlert size={18} /><span>{loadError}</span></div>
        ) : (
          <dl className="account-details" aria-busy={!profile}>
            <div><dt><Mail size={17} /> 邮箱地址</dt><dd>{profile?.email ?? '—'}</dd></div>
            <div><dt><CircleUserRound size={17} /> 显示名称</dt><dd>{profile?.display_name ?? '—'}</dd></div>
            <div><dt><Clock3 size={17} /> 时区</dt><dd>{profile?.timezone ?? '—'}</dd></div>
            <div><dt><CalendarDays size={17} /> 注册时间</dt><dd>{profile ? formatCreatedAt(profile.created_at) : '—'}</dd></div>
          </dl>
        )}
      </section>

      <section className="surface account-session-card">
        <div className="section-heading">
          <span className="section-icon"><KeyRound size={20} /></span>
          <div><h2>当前会话</h2><p>退出只结束当前浏览器的登录，不会删除已经保存的数据。</p></div>
        </div>
        <button type="button" className="account-action-button" onClick={onLogout} data-testid="logout-button">
          <LogOut size={18} /> 退出登录
        </button>
      </section>

      <section className="surface danger-zone">
        <div className="section-heading">
          <span className="section-icon danger-icon"><Trash2 size={20} /></span>
          <div>
            <h2>注销账户</h2>
            <p>注销后无法恢复登录。医疗档案和审计记录仍按治理规则保留，但此账户将失去全部访问权。</p>
          </div>
        </div>
        <button type="button" className="account-action-button danger" onClick={() => setDeleteOpen(true)} data-testid="open-delete-account">
          <Trash2 size={18} /> 注销我的账户
        </button>
      </section>

      {deleteOpen && createPortal(
        <div className="account-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDelete();
        }}>
          <section className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
            <button type="button" className="dialog-close" onClick={closeDelete} aria-label="关闭"><X size={20} /></button>
            <span className="dialog-danger-icon"><TriangleAlert size={26} /></span>
            <h2 id="delete-account-title">确认注销账户</h2>
            <p>这个操作不可撤销。你的登录身份会被匿名化，全部登录令牌和档案访问权将立即失效。</p>
            {queuedItemCount > 0 && (
              <div className="delete-queue-warning">
                <TriangleAlert size={18} />
                <span>当前设备还有 <strong>{queuedItemCount}</strong> 项未上传内容。注销成功后，这些本地原件将被永久清除。</span>
              </div>
            )}
            <label className="field-label">
              <span>输入当前密码</span>
              <span className="input-shell">
                <KeyRound size={19} />
                <input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)}
                       autoComplete="current-password" data-testid="delete-account-password" />
              </span>
            </label>
            <label className="delete-understanding">
              <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
              <span>我理解账户无法恢复，且本机未上传内容会被删除。</span>
            </label>
            {deleteError && <p className="error dialog-error" data-testid="delete-account-error">{deleteError}</p>}
            <div className="dialog-actions">
              <button type="button" className="dialog-cancel" onClick={closeDelete} disabled={deleting}>取消</button>
              <button type="button" className="dialog-confirm-danger" onClick={() => void submitDelete()}
                      disabled={!password || !understood || deleting} data-testid="confirm-delete-account">
                {deleting ? <><LoaderCircle className="spin" size={18} /> 正在注销…</> : <><Trash2 size={18} /> 永久注销账户</>}
              </button>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </div>
  );
}
