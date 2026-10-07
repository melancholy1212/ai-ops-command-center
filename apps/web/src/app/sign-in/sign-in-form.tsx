'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { initialAuthFormState } from '@/lib/auth-form-state';
import { signIn, signUp } from './actions';

export type Mode = 'sign-in' | 'sign-up';

// Plain links, so switching mode works even if JavaScript never loads.
const MODE_LINKS: readonly { mode: Mode; href: string; label: string }[] = [
  { mode: 'sign-in', href: '/sign-in', label: 'Sign in' },
  { mode: 'sign-up', href: '/sign-in?mode=sign-up', label: 'Create account' },
];

export function SignInForm({ mode }: { mode: Mode }) {
  const [signInState, signInAction, signInPending] = useActionState(signIn, initialAuthFormState);
  const [signUpState, signUpAction, signUpPending] = useActionState(signUp, initialAuthFormState);
  const state = mode === 'sign-in' ? signInState : signUpState;
  const pending = mode === 'sign-in' ? signInPending : signUpPending;

  return (
    <div className="rounded-lg border border-line bg-panel p-6">
      <nav aria-label="Account" className="grid grid-cols-2 gap-1 rounded-md bg-canvas p-1 text-center text-sm">
        {MODE_LINKS.map((link) => (
          <Link
            key={link.mode}
            href={link.href}
            replace
            aria-current={mode === link.mode ? 'page' : undefined}
            className={`rounded px-3 py-1.5 transition-colors ${
              mode === link.mode ? 'bg-raised text-ink' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <form action={mode === 'sign-in' ? signInAction : signUpAction} className="mt-6 space-y-4">
        <label className="block space-y-1.5 text-small font-medium text-ink-muted">
          <span>Email</span>
          <Input name="email" type="email" autoComplete="email" required />
        </label>
        <label className="block space-y-1.5 text-small font-medium text-ink-muted">
          <span>Password</span>
          <Input
            name="password"
            type="password"
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            minLength={8}
            maxLength={72}
            required
          />
        </label>

        {state.error ? (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        ) : null}
        {state.notice ? (
          <p role="status" className="text-sm text-ok">
            {state.notice}
          </p>
        ) : null}

        <Button type="submit" variant="primary" size="lg" disabled={pending} className="w-full">
          {pending ? 'Working…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
        </Button>
      </form>
    </div>
  );
}
