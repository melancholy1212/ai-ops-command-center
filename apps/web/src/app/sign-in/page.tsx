import type { Metadata } from 'next';
import Link from 'next/link';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <Link href="/" className="font-mono text-xs tracking-[0.2em] text-accent-cyan uppercase">
          AI Operations Command Center
        </Link>
        <h1 className="mt-3 mb-6 text-2xl font-semibold tracking-tight">Welcome back</h1>
        <SignInForm />
      </div>
    </main>
  );
}
