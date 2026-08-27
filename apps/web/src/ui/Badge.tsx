import React, { forwardRef } from 'react';
import {
  AlertTriangle, CheckCircle2, Clock3, FileStack, LoaderCircle,
  Trash2, UserRoundCheck, CircleAlert,
} from 'lucide-react';
import { cn } from './cn.js';

export type BadgeVariant = 'brand' | 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export type BadgeSize = 'sm' | 'md';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  dot?: boolean;
  icon?: React.ReactNode;
}

const variantStyles: Record<BadgeVariant, string> = {
  brand: 'bg-brand-50 text-brand-700 border-brand-200/80',
  neutral: 'bg-surface-subtle text-ink-secondary border-line',
  success: 'bg-success-bg text-success-text border-success-border',
  warning: 'bg-warning-bg text-warning-text border-warning-border',
  danger: 'bg-danger-bg text-danger-text border-danger-border',
  info: 'bg-info-bg text-info-text border-info-border',
};

const dotColors: Record<BadgeVariant, string> = {
  brand: 'bg-brand-500',
  neutral: 'bg-muted',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
};

const sizeStyles: Record<BadgeSize, string> = {
  sm: 'px-2 py-0.5 text-[11px] font-medium gap-1 rounded-md border',
  md: 'px-2.5 py-1 text-xs font-medium gap-1.5 rounded-lg border',
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { variant = 'neutral', size = 'sm', dot = false, icon, className, children, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center shrink-0 tracking-tight leading-none',
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
      {...props}
    >
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dotColors[variant])} />}
      {icon && <span className="shrink-0 inline-flex items-center [&>svg]:w-3.5 [&>svg]:h-3.5">{icon}</span>}
      {children && <span>{children}</span>}
    </span>
  );
});

export type CaptureQueueState =
  | 'draft'
  | 'pending_person'
  | 'pending'
  | 'uploading'
  | 'registering'
  | 'pending_discard'
  | 'failed_terminal';

const queueStateConfig: Record<
  CaptureQueueState,
  { label: string; variant: BadgeVariant; icon: React.ReactNode }
> = {
  draft: { label: '拍摄中', variant: 'brand', icon: <FileStack size={13} /> },
  pending_person: { label: '待归人', variant: 'warning', icon: <UserRoundCheck size={13} /> },
  pending: { label: '待上传', variant: 'neutral', icon: <Clock3 size={13} /> },
  uploading: { label: '上传中', variant: 'info', icon: <LoaderCircle className="animate-spin" size={13} /> },
  registering: { label: '登记中', variant: 'info', icon: <LoaderCircle className="animate-spin" size={13} /> },
  pending_discard: { label: '待放弃', variant: 'danger', icon: <Trash2 size={13} /> },
  failed_terminal: { label: '失败', variant: 'danger', icon: <CircleAlert size={13} /> },
};

export function QueueStateBadge({
  state,
  className,
}: {
  state: CaptureQueueState;
  className?: string;
}): JSX.Element {
  const config = queueStateConfig[state] ?? { label: state, variant: 'neutral', icon: <Clock3 size={13} /> };
  return (
    <Badge variant={config.variant} size="md" icon={config.icon} className={cn('font-medium', className)}>
      {config.label}
    </Badge>
  );
}

export function NormalizationStateBadge({
  state,
  className,
}: {
  state: 'proposed' | 'confirmed' | 'rejected';
  className?: string;
}): JSX.Element {
  if (state === 'confirmed') {
    return (
      <Badge variant="success" size="sm" icon={<CheckCircle2 size={13} />} className={className}>
        已确认
      </Badge>
    );
  }
  if (state === 'rejected') {
    return (
      <Badge variant="danger" size="sm" icon={<Trash2 size={13} />} className={className}>
        已拒绝
      </Badge>
    );
  }
  return (
    <Badge variant="warning" size="sm" dot className={className}>
      待确认
    </Badge>
  );
}
