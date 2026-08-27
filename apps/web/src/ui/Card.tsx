import React, { forwardRef } from 'react';
import { cn } from './cn.js';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'subtle' | 'bordered' | 'danger' | 'interactive';
}

const variantStyles = {
  default: 'bg-white/95 backdrop-blur-sm border border-line/80 shadow-soft',
  subtle: 'bg-surface-subtle/90 border border-line/60 shadow-xs',
  bordered: 'bg-white border-2 border-line-strong/80 shadow-xs',
  danger: 'bg-danger-bg/70 border border-danger-border/80 shadow-xs',
  interactive:
    'bg-white/95 hover:bg-white border border-line hover:border-brand-300 hover:shadow-md cursor-pointer transition-all duration-200 active:scale-[0.99]',
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { variant = 'default', className, children, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn('rounded-2xl p-5 md:p-6 transition-all', variantStyles[variant], className)}
      {...props}
    >
      {children}
    </div>
  );
});

export const CardHeader = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function CardHeader(
  { className, children, ...props },
  ref,
) {
  return (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 pb-4', className)} {...props}>
      {children}
    </div>
  );
});

export const CardTitle = forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(function CardTitle(
  { className, children, ...props },
  ref,
) {
  return (
    <h3 ref={ref} className={cn('text-lg md:text-xl font-semibold text-ink tracking-tight', className)} {...props}>
      {children}
    </h3>
  );
});

export const CardDescription = forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  function CardDescription({ className, children, ...props }, ref) {
    return (
      <p ref={ref} className={cn('text-sm text-muted leading-relaxed', className)} {...props}>
        {children}
      </p>
    );
  },
);

export const CardContent = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function CardContent(
  { className, children, ...props },
  ref,
) {
  return (
    <div ref={ref} className={cn('pt-0', className)} {...props}>
      {children}
    </div>
  );
});

export const CardFooter = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function CardFooter(
  { className, children, ...props },
  ref,
) {
  return (
    <div ref={ref} className={cn('flex items-center pt-4 border-t border-line/60', className)} {...props}>
      {children}
    </div>
  );
});
