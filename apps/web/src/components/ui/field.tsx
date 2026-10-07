import { ChevronDown } from 'lucide-react';
import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cx } from '@/lib/cx';

// One look for every text control. Focus moves the border to the accent; there is no glow and no shadow.
const CONTROL =
  'block w-full rounded-md border border-line bg-panel text-body text-ink transition-colors duration-120 placeholder:text-ink-subtle hover:border-line-strong focus:border-accent focus:outline-hidden disabled:cursor-not-allowed disabled:text-ink-disabled aria-invalid:border-danger';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(CONTROL, 'h-9 px-3', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(CONTROL, 'resize-y px-3 py-2', className)} {...props} />;
}

/** A native select, so it works without JavaScript and with the platform's keyboard and screen-reader support. */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={cx(CONTROL, 'h-9 appearance-none pr-9 pl-3', className)} {...props}>
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        size={16}
        strokeWidth={1.5}
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-subtle"
      />
    </div>
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cx('block text-small font-medium text-ink-muted', className)} {...props} />;
}

/** Help text under a field. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-meta text-ink-subtle">{children}</p>;
}
