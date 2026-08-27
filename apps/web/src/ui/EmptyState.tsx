import React, { forwardRef } from 'react';
import { cn } from './cn.js';

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  variant?: 'default' | 'card' | 'inline';
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { icon, title, description, action, variant = 'card', className, ...props },
  ref,
) {
  if (variant === 'inline') {
    return (
      <div
        ref={ref}
        className={cn(
          'flex items-center gap-3 p-4 rounded-xl bg-surface-subtle text-muted text-sm border border-line/60',
          className,
        )}
        {...props}
      >
        {icon && <span className="shrink-0 text-brand-600 [&>svg]:w-5 [&>svg]:h-5">{icon}</span>}
        <span className="flex-1 font-medium">{title}</span>
        {action}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={cn(
        'flex flex-col items-center justify-center text-center p-8 md:p-12 transition-all',
        variant === 'card' && 'bg-white/95 backdrop-blur-sm border border-line/80 rounded-3xl shadow-soft',
        className,
      )}
      {...props}
    >
      {icon && (
        <div className="w-14 h-14 md:w-16 md:h-16 rounded-2xl bg-brand-50/80 border border-brand-100 text-brand-600 flex items-center justify-center mb-4 shrink-0 shadow-xs [&>svg]:w-7 [&>svg]:h-7">
          {icon}
        </div>
      )}
      <h3 className="text-lg md:text-xl font-semibold text-ink tracking-tight mb-1.5">{title}</h3>
      {description && <p className="text-sm text-muted max-w-md leading-relaxed mb-5">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
});
