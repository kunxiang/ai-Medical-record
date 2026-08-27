import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, LoaderCircle, UserPlus, UserRound, UsersRound, X } from 'lucide-react';
import { ApiFailure, type CreatePersonInput } from '../../api/client.js';

type Relation = CreatePersonInput['relation_to_owner'];
type SexAtBirth = CreatePersonInput['sex_at_birth'];

function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createErrorMessage(cause: unknown): string {
  if (cause instanceof ApiFailure) {
    if (cause.status === 401) return '登录已失效，请重新登录后再添加成员。';
    if (cause.code === 'validation_failed' || cause.status === 422) return '请检查姓名和出生日期是否正确。';
    if (cause.code === 'rate_limited' || cause.status === 429) return '操作过于频繁，请稍后再试。';
    return '创建失败，请稍后重试。';
  }
  if (cause instanceof TypeError) return '无法连接服务器，请检查网络后重试。';
  return '创建失败，请稍后重试。';
}

export function CreatePersonDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: CreatePersonInput) => Promise<void>;
}): JSX.Element {
  const [displayName, setDisplayName] = useState('');
  const [relation, setRelation] = useState<Relation>('child');
  const [birthDate, setBirthDate] = useState('');
  const [sexAtBirth, setSexAtBirth] = useState<SexAtBirth>('unknown');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [busy, onClose]);

  async function submit(): Promise<void> {
    const name = displayName.trim();
    if (!name || !birthDate) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        display_name: name,
        birth_date: birthDate,
        sex_at_birth: sexAtBirth,
        relation_to_owner: relation,
      });
    } catch (cause) {
      setError(createErrorMessage(cause));
      setBusy(false);
    }
  }

  return createPortal(
    <div className="account-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="person-dialog" role="dialog" aria-modal="true" aria-labelledby="create-person-title">
        <button type="button" className="dialog-close" onClick={onClose} disabled={busy} aria-label="关闭">
          <X size={20} />
        </button>
        <span className="person-dialog-icon"><UserPlus size={25} /></span>
        <h2 id="create-person-title">添加家庭成员</h2>
        <p>为每位成员建立独立档案，上传时就不会混淆归属。</p>
        <form className="person-dialog-form" onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}>
          <label className="field-label">
            <span>成员姓名</span>
            <span className="input-shell">
              <UserRound size={19} aria-hidden="true" />
              <input autoFocus type="text" value={displayName} onChange={(event) => setDisplayName(event.target.value)}
                     placeholder="例如：小明" maxLength={64} required data-testid="person-name" />
            </span>
          </label>
          <label className="field-label">
            <span>与我的关系</span>
            <span className="input-shell">
              <UsersRound size={19} aria-hidden="true" />
              <select value={relation} onChange={(event) => setRelation(event.target.value as Relation)}
                      data-testid="person-relation">
                <option value="child">子女</option>
                <option value="spouse">配偶</option>
                <option value="parent">父母</option>
                <option value="sibling">兄弟姐妹</option>
                <option value="other">其他</option>
              </select>
            </span>
          </label>
          <div className="person-form-grid">
            <label className="field-label">
              <span>出生日期</span>
              <span className="input-shell">
                <CalendarDays size={19} aria-hidden="true" />
                <input type="date" value={birthDate} onChange={(event) => setBirthDate(event.target.value)}
                       max={localToday()} required data-testid="person-birth-date" />
              </span>
            </label>
            <label className="field-label">
              <span>出生时性别</span>
              <span className="input-shell">
                <UserRound size={19} aria-hidden="true" />
                <select value={sexAtBirth} onChange={(event) => setSexAtBirth(event.target.value as SexAtBirth)}
                        data-testid="person-sex-at-birth">
                  <option value="unknown">暂不填写</option>
                  <option value="female">女</option>
                  <option value="male">男</option>
                </select>
              </span>
            </label>
          </div>
          <small className="person-form-note">出生信息用于区分档案，并为后续医疗记录整理提供基础信息。</small>
          {error && <p className="error dialog-error" data-testid="create-person-error">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="dialog-cancel" onClick={onClose} disabled={busy}>取消</button>
            <button type="submit" className="dialog-confirm" disabled={busy || !displayName.trim() || !birthDate}
                    data-testid="confirm-create-person">
              {busy ? <><LoaderCircle className="spin" size={18} /> 正在创建…</> : <><UserPlus size={18} /> 创建并切换</>}
            </button>
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}
