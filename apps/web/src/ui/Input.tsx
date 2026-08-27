import React, { forwardRef } from 'react';
import { cn } from './cn.js';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  hasError?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { iconLeft, iconRight, hasError, className, disabled, type = 'text', ...props },
  ref,
) {
  return (
    <div className="relative flex items-center w-full">
      {iconLeft && (
        <span className="absolute left-3.5 flex items-center justify-center text-muted pointer-events-none shrink-0 [&>svg]:w-4.5 [&>svg]:h-4.5">
          {iconLeft}
        </span>
      )}
      <input
        ref={ref}
        type={type}
        disabled={disabled}
        className={cn(
          'w-full min-h-[44px] px-3.5 py-2.5 rounded-xl text-sm font-normal text-ink placeholder:text-subtle/70 bg-white/90 border transition-all duration-150',
          'border-line hover:border-line-strong focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 shadow-xs',
          'disabled:bg-surface-subtle disabled:text-muted disabled:cursor-not-allowed disabled:border-line/60',
          iconLeft && 'pl-10.5',
          iconRight && 'pr-10.5',
          hasError && 'border-danger focus:ring-danger/20 focus:border-danger text-danger-text',
          className,
        )}
        {...props}
      />
      {iconRight && (
        <span className="absolute right-3.5 flex items-center justify-center text-muted pointer-events-none shrink-0 [&>svg]:w-4.5 [&>svg]:h-4.5">
          {iconRight}
        </span>
      )}
    </div>
  );
});
