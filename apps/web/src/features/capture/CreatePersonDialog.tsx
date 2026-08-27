import { useState } from 'react';
import { CalendarDays, UserPlus, UserRound, UsersRound } from 'lucide-react';
import { ApiFailure, type CreatePersonInput } from '../../api/client.js';
import { Dialog } from '../../ui/Dialog.js';
import { Field } from '../../ui/Field.js';
import { Input } from '../../ui/Input.js';
import { Select } from '../../ui/Select.js';
import { Button } from '../../ui/Button.js';
import { Alert } from '../../ui/Alert.js';

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

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      icon={<UserPlus size={24} />}
      title="添加家庭成员"
      description="为每位成员建立独立档案，上传时就不会混淆归属。"
      aria-labelledby="create-person-title"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4 pt-1"
      >
        <Field label="成员姓名" required>
          <Input
            autoFocus
            iconLeft={<UserRound size={17} />}
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="例如：小明"
            maxLength={64}
            required
            data-testid="person-name"
          />
        </Field>

        <Field label="与我的关系" required>
          <Select
            iconLeft={<UsersRound size={17} />}
            value={relation}
            onChange={(e) => setRelation(e.target.value as Relation)}
            data-testid="person-relation"
          >
            <option value="child">子女</option>
            <option value="spouse">配偶</option>
            <option value="parent">父母</option>
            <option value="sibling">兄弟姐妹</option>
            <option value="other">其他</option>
          </Select>
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <Field label="出生日期" required>
            <Input
              iconLeft={<CalendarDays size={17} />}
              type="date"
              value={birthDate}
              onChange={(e) => setBirthDate(e.target.value)}
              max={localToday()}
              required
              data-testid="person-birth-date"
            />
          </Field>

          <Field label="出生时性别">
            <Select
              iconLeft={<UserRound size={17} />}
              value={sexAtBirth}
              onChange={(e) => setSexAtBirth(e.target.value as SexAtBirth)}
              data-testid="person-sex-at-birth"
            >
              <option value="unknown">暂不填写</option>
              <option value="female">女</option>
              <option value="male">男</option>
            </Select>
          </Field>
        </div>

        <p className="text-xs text-muted leading-relaxed">
          出生信息用于区分档案，并为后续医疗记录整理提供基础信息。
        </p>

        {error && (
          <Alert variant="danger" data-testid="create-person-error">
            {error}
          </Alert>
        )}

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-line/60">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            type="submit"
            loading={busy}
            disabled={busy || !displayName.trim() || !birthDate}
            iconLeft={!busy ? <UserPlus size={17} /> : undefined}
            data-testid="confirm-create-person"
          >
            创建并切换
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
