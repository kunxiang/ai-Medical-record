import React, { forwardRef } from 'react';
import { cn } from './cn.js';

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: React.ReactNode;
  error?: React.ReactNode;
}

export const Field = forwardRef<HTMLDivElement, FieldProps>(function Field(
  { label, htmlFor, required, hint, error, className, children, ...props },
  ref,
) {
  return (
    <div ref={ref} className={cn('flex flex-col gap-1.5 w-full', className)} {...props}>
      {label && (
        <label htmlFor={htmlFor} className="text-xs font-semibold text-ink-secondary tracking-wide flex items-center gap-1">
          <span>{label}</span>
          {required && <span className="text-danger font-bold">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <p className="text-xs text-muted leading-normal mt-0.5">{hint}</p>}
      {error && <p className="text-xs font-medium text-danger leading-normal mt-0.5">{error}</p>}
    </div>
  );
});
