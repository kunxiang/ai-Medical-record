import { HeartPulse } from 'lucide-react';

export function BrandMark({ compact = false }: { compact?: boolean }): JSX.Element {
  return (
    <div className={compact ? 'brand-mark compact' : 'brand-mark'}>
      <span className="brand-symbol" aria-hidden="true">
        <HeartPulse strokeWidth={2.2} />
      </span>
      <span className="brand-copy">
        <strong>MediReco</strong>
        <small>家庭健康档案</small>
      </span>
    </div>
  );
}
