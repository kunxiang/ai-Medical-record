import React, { forwardRef } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from './cn.js';
import type { ButtonVariant, ButtonSize } from './Button.js';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  'aria-label': string;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-500 hover:bg-brand-600 active:bg-brand-700 text-white shadow-sm border border-brand-600/30 focus-visible:ring-brand-500',
  secondary:
    'bg-white hover:bg-brand-50/50 active:bg-brand-100/60 text-ink border border-line hover:border-line-strong shadow-xs focus-visible:ring-brand-500',
  soft:
    'bg-brand-50 hover:bg-brand-100/80 active:bg-brand-200/70 text-brand-700 border border-brand-200/70 focus-visible:ring-brand-500',
  outline:
    'bg-transparent hover:bg-white text-ink border border-line hover:border-line-strong active:bg-brand-50/40 focus-visible:ring-brand-500',
  ghost:
    'bg-transparent hover:bg-brand-50/70 active:bg-brand-100/70 text-ink-secondary hover:text-ink focus-visible:ring-brand-500',
  danger:
    'bg-danger hover:bg-red-700 active:bg-red-800 text-white shadow-sm border border-red-700/30 focus-visible:ring-danger',
  'danger-soft':
    'bg-danger-bg hover:bg-red-100 active:bg-red-200 text-danger-text border border-danger-border focus-visible:ring-danger',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'w-9 h-9 min-w-[36px] min-h-[36px] p-1.5 rounded-lg text-sm',
  md: 'w-11 h-11 min-w-[44px] min-h-[44px] p-2.5 rounded-xl text-base',
  lg: 'w-12 h-12 min-w-[48px] min-h-[48px] p-3 rounded-xl text-lg',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    variant = 'ghost',
    size = 'md',
    loading = false,
    className,
    disabled,
    children,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center transition-all duration-150 select-none cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
      {...props}
    >
      {loading ? <LoaderCircle className="animate-spin shrink-0" size={18} /> : children}
    </button>
  );
});
