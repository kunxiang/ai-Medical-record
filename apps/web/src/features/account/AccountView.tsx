import { useEffect, useState } from 'react';
import {
  CalendarDays, CircleUserRound, Clock3, Download, KeyRound, LogOut, Mail,
  ShieldCheck, Sparkles, Trash2, TriangleAlert,
} from 'lucide-react';
import type { AccountProfileT, CapabilitiesResponseT } from '@amr/contracts';
import { api, ApiFailure } from '../../api/client.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Card } from '../../ui/Card.js';
import { Button } from '../../ui/Button.js';
import { Dialog } from '../../ui/Dialog.js';
import { Field } from '../../ui/Field.js';
import { Input } from '../../ui/Input.js';
import { Alert } from '../../ui/Alert.js';
import { cn } from '../../ui/cn.js';

function formatCreatedAt(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function AccountView({
  queuedItemCount,
  people,
  onLogout,
  onDeleteAccount,
  capabilities,
  capabilityStatus,
}: {
  queuedItemCount: number;
  people: Array<{ id: string; display_name: string }>;
  onLogout: () => void;
  onDeleteAccount: (password: string) => Promise<void>;
  capabilities: CapabilitiesResponseT;
  capabilityStatus: 'loading' | 'known' | 'unknown';
}): JSX.Element {
  const [profile, setProfile] = useState<AccountProfileT | null>(null);
  const [bundlePersonId, setBundlePersonId] = useState<string | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.account().then(
      (value) => {
        if (!cancelled) setProfile(value);
      },
      () => {
        if (!cancelled) setLoadError('账户信息暂时无法加载，请检查网络后重试。');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

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

  const downloadBundle = async (personId: string): Promise<void> => {
    setBundlePersonId(personId);
    setBundleError(null);
    try {
      const result = await api.downloadPersonBundle(personId);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setBundleError(cause instanceof Error ? cause.message : '档案包下载失败');
    } finally {
      setBundlePersonId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="账户与隐私"
        title="账户中心"
        description="查看登录身份、管理当前会话，并控制账户访问权限。"
        action={
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/90 text-brand-700 border border-brand-200 shadow-2xs">
            <ShieldCheck size={16} className="text-brand-600" /> 登录信息受保护
          </span>
        }
      />

      {/* Account Profile Card */}
      <Card className="space-y-6" aria-labelledby="account-profile-title">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-brand-500 text-white flex items-center justify-center shrink-0 shadow-sm font-bold text-xl">
            {profile?.display_name ? (
              profile.display_name.slice(0, 1)
            ) : (
              <CircleUserRound size={32} />
            )}
          </div>
          <div className="space-y-0.5 min-w-0">
            <span className="text-xs font-bold text-brand-600 tracking-wide uppercase">
              当前账户
            </span>
            <h2 id="account-profile-title" className="text-xl font-bold text-ink truncate">
              {profile?.display_name ?? '正在加载…'}
            </h2>
            <p className="text-xs text-muted truncate">{profile?.email ?? '读取账户信息'}</p>
          </div>
        </div>

        {loadError ? (
          <Alert variant="warning">
            <span>{loadError}</span>
          </Alert>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-line/60">
            <div className="flex items-start gap-3 p-3.5 rounded-xl bg-surface-subtle border border-line/60">
              <Mail size={18} className="text-brand-600 mt-0.5 shrink-0" />
              <div className="space-y-0.5">
                <span className="text-xs text-muted block">邮箱地址</span>
                <strong className="text-sm text-ink font-semibold block">{profile?.email ?? '—'}</strong>
              </div>
            </div>

            <div className="flex items-start gap-3 p-3.5 rounded-xl bg-surface-subtle border border-line/60">
              <CircleUserRound size={18} className="text-brand-600 mt-0.5 shrink-0" />
              <div className="space-y-0.5">
                <span className="text-xs text-muted block">显示名称</span>
                <strong className="text-sm text-ink font-semibold block">{profile?.display_name ?? '—'}</strong>
              </div>
            </div>

            <div className="flex items-start gap-3 p-3.5 rounded-xl bg-surface-subtle border border-line/60">
              <Clock3 size={18} className="text-brand-600 mt-0.5 shrink-0" />
              <div className="space-y-0.5">
                <span className="text-xs text-muted block">时区</span>
                <strong className="text-sm text-ink font-semibold block">{profile?.timezone ?? '—'}</strong>
              </div>
            </div>

            <div className="flex items-start gap-3 p-3.5 rounded-xl bg-surface-subtle border border-line/60">
              <CalendarDays size={18} className="text-brand-600 mt-0.5 shrink-0" />
              <div className="space-y-0.5">
                <span className="text-xs text-muted block">注册时间</span>
                <strong className="text-sm text-ink font-semibold block">
                  {profile ? formatCreatedAt(profile.created_at) : '—'}
                </strong>
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-surface-subtle text-brand-600 flex items-center justify-center shrink-0">
            <Sparkles size={20} />
          </div>
          <div>
            <h2 className="text-base font-bold text-ink">智能辅助</h2>
            <p className="text-xs text-muted">
              {capabilityStatus === 'loading'
                ? '正在确认可用状态…'
                : capabilityStatus === 'unknown'
                  ? '状态未知，已按关闭处理；核心功能可正常使用。'
                  : capabilities.assist.available
                    ? `当前可用，共 ${capabilities.assist.capabilities.length} 项辅助能力。`
                    : '当前未启用；归档、浏览和账户功能不受影响。'}
            </p>
          </div>
        </div>
      </Card>

      <Card className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-surface-subtle text-brand-600 flex items-center justify-center shrink-0">
            <Download size={20} />
          </div>
          <div>
            <h2 className="text-base font-bold text-ink">导出档案包</h2>
            <p className="text-xs text-muted">
              按成员打包该人的原件与已确认事实，用于备份或换设备；不包含其他成员的数据。
            </p>
          </div>
        </div>

        {bundleError && <Alert variant="danger"><span>{bundleError}</span></Alert>}

        <div className="grid gap-2 sm:grid-cols-2">
          {people.map((item) => (
            <Button
              key={item.id}
              variant="outline"
              size="md"
              className="justify-between"
              loading={bundlePersonId === item.id}
              disabled={bundlePersonId !== null && bundlePersonId !== item.id}
              onClick={() => void downloadBundle(item.id)}
              data-testid={`bundle-${item.id}`}
            >
              <span className="truncate">{item.display_name}</span>
              <Download size={15} />
            </Button>
          ))}
        </div>
      </Card>

      {/* Session Management Card */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-line/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
              <KeyRound size={20} />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">当前会话</h2>
              <p className="text-xs text-muted">退出只结束当前浏览器的登录，不会删除已经保存的数据。</p>
            </div>
          </div>
        </div>

        <div className="pt-1">
          <Button
            variant="secondary"
            size="md"
            onClick={onLogout}
            iconLeft={<LogOut size={17} />}
            data-testid="logout-button"
            className="rounded-xl font-semibold hover:bg-brand-50 hover:text-brand-700"
          >
            退出登录
          </Button>
        </div>
      </Card>

      {/* Danger Zone: Account Deletion */}
      <Card className="space-y-4 bg-danger-bg/30 border-danger-border/60">
        <div className="flex items-center justify-between pb-3 border-b border-danger-border/40">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-danger-bg text-danger flex items-center justify-center shrink-0 border border-danger-border/60">
              <Trash2 size={20} />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">注销账户</h2>
              <p className="text-xs text-muted">
                注销后无法恢复登录。医疗档案和审计记录仍按治理规则保留，但此账户将失去全部访问权。
              </p>
            </div>
          </div>
        </div>

        <div className="pt-1">
          <Button
            variant="danger-soft"
            size="md"
            onClick={() => setDeleteOpen(true)}
            iconLeft={<Trash2 size={17} />}
            data-testid="open-delete-account"
            className="rounded-xl font-semibold"
          >
            注销我的账户
          </Button>
        </div>
      </Card>

      {/* Delete Confirmation Modal */}
      {deleteOpen && (
        <Dialog
          open
          onClose={closeDelete}
          icon={<TriangleAlert size={26} className="text-danger" />}
          title="确认注销账户"
          description="这个操作不可撤销。你的登录身份会被匿名化，全部登录令牌和档案访问权将立即失效。"
          aria-labelledby="delete-account-title"
          size="md"
        >
          <div className="space-y-4 pt-1">
            {queuedItemCount > 0 && (
              <Alert variant="warning">
                <span>
                  当前设备还有 <strong>{queuedItemCount}</strong> 项未上传内容。注销成功后，这些本地原件将被永久清除。
                </span>
              </Alert>
            )}

            <Field label="输入当前密码" required>
              <Input
                autoFocus
                iconLeft={<KeyRound size={17} />}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                data-testid="delete-account-password"
                placeholder="验证你的当前密码"
                required
              />
            </Field>

            <label className="flex items-start gap-2.5 p-3 rounded-xl bg-surface-subtle border border-line/80 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded text-brand-600 focus:ring-brand-500 cursor-pointer"
              />
              <span className="text-xs font-medium text-ink-secondary leading-snug">
                我理解账户无法恢复，且本机未上传内容会被删除。
              </span>
            </label>

            {deleteError && (
              <Alert variant="danger" data-testid="delete-account-error">
                {deleteError}
              </Alert>
            )}

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-line/60">
              <Button variant="ghost" onClick={closeDelete} disabled={deleting}>
                取消
              </Button>
              <Button
                variant="danger"
                loading={deleting}
                disabled={!password || !understood || deleting}
                onClick={() => void submitDelete()}
                iconLeft={!deleting ? <Trash2 size={17} /> : undefined}
                data-testid="confirm-delete-account"
                className="rounded-xl shadow-xs"
              >
                永久注销账户
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
