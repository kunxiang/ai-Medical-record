import React, { forwardRef } from 'react';
import { AlertTriangle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from './cn.js';

export type AlertVariant = 'warning' | 'danger' | 'info' | 'success';

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  variant?: AlertVariant;
  title?: React.ReactNode;
  icon?: React.ReactNode;
  onClose?: () => void;
}

const variantStyles: Record<
  AlertVariant,
  { container: string; icon: string; defaultIcon: React.ReactNode }
> = {
  warning: {
    container: 'bg-warning-bg border-warning-border text-warning-text',
    icon: 'text-warning',
    defaultIcon: <TriangleAlert size={18} />,
  },
  danger: {
    container: 'bg-danger-bg border-danger-border text-danger-text',
    icon: 'text-danger',
    defaultIcon: <AlertTriangle size={18} />,
  },
  info: {
    container: 'bg-info-bg border-info-border text-info-text',
    icon: 'text-info',
    defaultIcon: <Info size={18} />,
  },
  success: {
    container: 'bg-success-bg border-success-border text-success-text',
    icon: 'text-success',
    defaultIcon: <CheckCircle2 size={18} />,
  },
};

export const Alert = forwardRef<HTMLDivElement, AlertProps>(function Alert(
  { variant = 'warning', title, icon, onClose, className, children, ...props },
  ref,
) {
  const config = variantStyles[variant];

  return (
    <div
      ref={ref}
      role="alert"
      className={cn(
        'flex items-start gap-3 p-4 rounded-xl border text-sm leading-relaxed transition-all shadow-xs',
        config.container,
        className,
      )}
      {...props}
    >
      <span className={cn('shrink-0 mt-0.5 inline-flex items-center justify-center', config.icon)}>
        {icon ?? config.defaultIcon}
      </span>
      <div className="flex-1 min-w-0 space-y-1">
        {title && <h5 className="font-semibold tracking-tight leading-snug">{title}</h5>}
        <div className="text-xs md:text-sm leading-relaxed opacity-95">{children}</div>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭提示"
          className="shrink-0 -mr-1 -mt-1 p-1.5 rounded-lg opacity-70 hover:opacity-100 hover:bg-black/5 transition-opacity"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
});
