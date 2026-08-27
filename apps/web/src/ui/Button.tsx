import React, { forwardRef } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from './cn.js';

export type ButtonVariant = 'primary' | 'secondary' | 'soft' | 'outline' | 'ghost' | 'danger' | 'danger-soft';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
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
  sm: 'min-h-[36px] px-3 py-1.5 text-xs gap-1.5 rounded-lg',
  md: 'min-h-[44px] px-4 py-2.5 text-sm gap-2 rounded-xl',
  lg: 'min-h-[48px] px-6 py-3 text-base gap-2.5 rounded-xl font-medium',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    fullWidth = false,
    iconLeft,
    iconRight,
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
        'inline-flex items-center justify-center font-medium transition-all duration-150 select-none cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
        variantStyles[variant],
        sizeStyles[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {loading ? (
        <LoaderCircle className="animate-spin shrink-0" size={size === 'sm' ? 14 : size === 'lg' ? 20 : 17} />
      ) : (
        iconLeft && <span className="shrink-0 inline-flex items-center">{iconLeft}</span>
      )}
      {children && <span>{children}</span>}
      {!loading && iconRight && <span className="shrink-0 inline-flex items-center">{iconRight}</span>}
    </button>
  );
});
