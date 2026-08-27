import React, { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn.js';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  iconLeft?: React.ReactNode;
  hasError?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { iconLeft, hasError, className, disabled, children, ...props },
  ref,
) {
  return (
    <div className="relative flex items-center w-full">
      {iconLeft && (
        <span className="absolute left-3.5 flex items-center justify-center text-muted pointer-events-none shrink-0 [&>svg]:w-4.5 [&>svg]:h-4.5">
          {iconLeft}
        </span>
      )}
      <select
        ref={ref}
        disabled={disabled}
        className={cn(
          'w-full min-h-[44px] px-3.5 py-2.5 pr-10 rounded-xl text-sm font-normal text-ink bg-white/90 border transition-all duration-150 appearance-none cursor-pointer',
          'border-line hover:border-line-strong focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 shadow-xs',
          'disabled:bg-surface-subtle disabled:text-muted disabled:cursor-not-allowed disabled:border-line/60',
          iconLeft && 'pl-10.5',
          hasError && 'border-danger focus:ring-danger/20 focus:border-danger text-danger-text',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <span className="absolute right-3.5 flex items-center justify-center text-muted pointer-events-none shrink-0">
        <ChevronDown size={17} />
      </span>
    </div>
  );
});
