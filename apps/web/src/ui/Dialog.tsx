import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from './cn.js';

export interface DialogProps {
  open?: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  icon?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  className?: string;
  closeOnBackdropClick?: boolean;
  closeOnEsc?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

const sizeStyles = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
  full: 'max-w-4xl',
};

export function Dialog({
  open = true,
  onClose,
  title,
  description,
  children,
  icon,
  size = 'md',
  className,
  closeOnBackdropClick = true,
  closeOnEsc = true,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: DialogProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (closeOnEsc && event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, closeOnEsc, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/50 backdrop-blur-sm animate-in fade-in duration-150 overflow-y-auto"
      onMouseDown={(e) => {
        if (closeOnBackdropClick && e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cn(
          'relative w-full bg-white rounded-3xl shadow-modal border border-line/60 p-6 md:p-8 my-auto',
          'max-h-[90vh] overflow-y-auto flex flex-col',
          'animate-in zoom-in-95 duration-150 ease-out',
          sizeStyles[size],
          className,
        )}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="absolute right-4.5 top-4.5 p-2 text-muted hover:text-ink hover:bg-brand-50 rounded-xl transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <X size={20} />
        </button>

        {(icon || title || description) && (
          <div className="flex flex-col gap-2 mb-5 pr-8">
            {icon && (
              <div className="w-12 h-12 rounded-2xl bg-brand-50 text-brand-600 flex items-center justify-center mb-1 shrink-0">
                {icon}
              </div>
            )}
            {title && (
              <h2
                id={ariaLabelledBy}
                className="text-xl md:text-2xl font-bold text-ink tracking-tight leading-snug"
              >
                {title}
              </h2>
            )}
            {description && (
              <p className="text-sm text-muted leading-relaxed">
                {description}
              </p>
            )}
          </div>
        )}

        <div className="flex-1">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
