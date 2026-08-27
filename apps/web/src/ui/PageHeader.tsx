import React, { forwardRef } from 'react';
import { cn } from './cn.js';

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

export const PageHeader = forwardRef<HTMLDivElement, PageHeaderProps>(function PageHeader(
  { eyebrow, title, description, action, className, ...props },
  ref,
) {
  return (
    <header
      ref={ref}
      className={cn(
        'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-2',
        className,
      )}
      {...props}
    >
      <div className="space-y-1">
        {eyebrow && (
          <span className="inline-block text-xs font-bold tracking-wider text-brand-600 uppercase">
            {eyebrow}
          </span>
        )}
        <h1 className="text-2xl sm:text-3xl font-extrabold text-ink tracking-tight">
          {title}
        </h1>
        {description && (
          <p className="text-sm text-muted leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0 flex items-center gap-2 self-start sm:self-auto">{action}</div>}
    </header>
  );
});
