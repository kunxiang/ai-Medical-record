import { Check, Plus, UserRound, UsersRound } from 'lucide-react';
import type { Person } from '../App.js';
import { Card } from './Card.js';
import { Button } from './Button.js';
import { EmptyState } from './EmptyState.js';
import { cn } from './cn.js';

const RELATION_LABELS: Record<string, string> = {
  self: '本人',
  spouse: '配偶',
  parent: '父母',
  child: '子女',
  sibling: '兄弟姐妹',
  other: '其他',
};

export interface PersonSelectorProps {
  people: Person[];
  selected: Person | null;
  onSelect: (person: Person) => void;
  onAddPerson?: () => void;
  title?: string;
  subtitle?: string;
  className?: string;
}

export function PersonSelector({
  people,
  selected,
  onSelect,
  onAddPerson,
  title = '这是谁的记录？',
  subtitle = '上传前必须确认归属，避免家庭成员档案混淆。',
  className,
}: PersonSelectorProps): JSX.Element {
  return (
    <Card className={cn('space-y-4', className)} data-testid="person-picker">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-1 border-b border-line/60">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center shrink-0">
            <UsersRound size={20} />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-bold text-ink leading-snug">{title}</h2>
            <p className="text-xs text-muted leading-tight">{subtitle}</p>
          </div>
        </div>
        {onAddPerson && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onAddPerson}
            iconLeft={<Plus size={15} />}
            data-testid="add-person"
            className="self-start sm:self-auto rounded-xl hover:bg-brand-50"
          >
            添加成员
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-2.5">
        {people.map((p) => {
          const isSelected = selected?.id === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p)}
              data-testid={`person-${p.slug}`}
              className={cn(
                'group relative flex items-center gap-2.5 min-h-[44px] px-3.5 py-2 rounded-2xl border text-left transition-all duration-150 cursor-pointer',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1',
                isSelected
                  ? 'bg-brand-500 border-brand-600 text-white shadow-sm ring-2 ring-brand-500/20'
                  : 'bg-white hover:bg-brand-50/40 border-line hover:border-brand-300 text-ink shadow-xs',
              )}
            >
              <span
                className={cn(
                  'w-7 h-7 rounded-xl flex items-center justify-center font-bold text-xs shrink-0 transition-colors',
                  isSelected ? 'bg-white text-brand-700' : 'bg-brand-50 text-brand-700 group-hover:bg-brand-100',
                )}
              >
                {p.display_name.slice(0, 1)}
              </span>
              <div className="flex flex-col leading-tight">
                <span className={cn('text-sm font-semibold', isSelected ? 'text-white' : 'text-ink')}>
                  {p.display_name}
                </span>
                <span className={cn('text-[11px]', isSelected ? 'text-white/80' : 'text-muted')}>
                  {RELATION_LABELS[p.relation_to_owner] ?? '家庭成员'}
                </span>
              </div>
              {isSelected && (
                <Check className="ml-1 text-white shrink-0 animate-in zoom-in-75 duration-150" size={16} />
              )}
            </button>
          );
        })}

        {people.length === 0 && (
          <EmptyState
            variant="inline"
            icon={<UserRound size={18} />}
            title="暂无档案，请先添加家庭成员"
            className="w-full"
          />
        )}
      </div>
    </Card>
  );
}
