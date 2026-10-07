import type { ButtonHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-120 disabled:pointer-events-none';

const VARIANT: Record<ButtonVariant, string> = {
  // The action a screen exists for, one per view. Dark text on the accent keeps contrast high. Disabled, it looks
  // like any disabled button instead of fading the accent into olive.
  primary:
    'border border-transparent bg-accent text-canvas hover:bg-accent/90 disabled:border-line disabled:bg-raised disabled:text-ink-subtle',
  secondary:
    'border border-line bg-raised text-ink hover:border-line-strong hover:bg-elevated disabled:text-ink-subtle',
  ghost: 'text-ink-muted hover:bg-raised hover:text-ink disabled:text-ink-disabled',
  // Destructive, and quiet until hovered: the colour is in the label, not a red block.
  danger: 'border border-line bg-raised text-danger hover:border-danger/50 hover:bg-elevated disabled:text-ink-subtle',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-small',
  md: 'h-8 px-3 text-small',
  lg: 'h-9 px-4 text-body',
};

interface ButtonStyle {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
}

/** The button look, for a link that acts as a button. */
export function buttonClass({ variant = 'secondary', size = 'md' }: ButtonStyle = {}): string {
  return cx(BASE, VARIANT[variant], SIZE[size]);
}

export function Button({
  variant,
  size,
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & ButtonStyle) {
  return <button type={type} className={cx(buttonClass({ variant, size }), className)} {...props} />;
}
