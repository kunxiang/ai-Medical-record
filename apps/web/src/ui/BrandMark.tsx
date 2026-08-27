import { HeartPulse } from 'lucide-react';
import { cn } from './cn.js';

export interface BrandMarkProps {
  compact?: boolean;
  className?: string;
}

export function BrandMark({ compact = false, className }: BrandMarkProps): JSX.Element {
  return (
    <div className={cn('inline-flex items-center gap-2.5 select-none', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'flex items-center justify-center rounded-2xl bg-brand-500 text-white shadow-brand transition-all shrink-0',
          compact ? 'w-9 h-9 p-1.5 rounded-xl shadow-xs' : 'w-12 h-12 p-2.5 shadow-sm',
        )}
      >
        <HeartPulse strokeWidth={2.4} className={compact ? 'w-5 h-5' : 'w-7 h-7'} />
      </span>
      <div className="flex flex-col leading-tight">
        <span
          className={cn(
            'font-black tracking-tight text-ink font-sans',
            compact ? 'text-base' : 'text-xl',
          )}
        >
          MediReco
        </span>
        <span className={cn('text-muted font-medium tracking-wide', compact ? 'text-[11px]' : 'text-xs')}>
          家庭健康档案
        </span>
      </div>
    </div>
  );
}
