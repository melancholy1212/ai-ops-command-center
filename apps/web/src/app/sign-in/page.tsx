import type { Metadata } from 'next';
import Link from 'next/link';
import { type Mode, SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ mode?: string | string[] }> }) {
  const { mode: requested } = await searchParams;
  const mode: Mode = requested === 'sign-up' ? 'sign-up' : 'sign-in';
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <Link href="/" className="font-mono text-xs tracking-[0.2em] text-accent-cyan uppercase">
          AI Operations Command Center
        </Link>
        <h1 className="mt-3 mb-6 text-2xl font-semibold tracking-tight">
          {mode === 'sign-in' ? 'Welcome back' : 'Create your account'}
        </h1>
        <SignInForm mode={mode} />
      </div>
    </main>
  );
}
