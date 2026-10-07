import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const PILLARS = [
  {
    title: 'Durable task graph',
    body: 'Agents run as leased tasks in Postgres. Crashes, deploys and retries lose nothing.',
  },
  { title: 'Traceable evidence', body: 'Every fact links to an exact quote in a saved snapshot of its source.' },
  { title: 'Human approval', body: 'Plans and outreach wait for your decision on a frozen, hashed version.' },
];

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims.sub);

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col justify-center px-6 py-16">
      <p className="font-mono text-xs tracking-[0.2em] text-ink-subtle uppercase">AI Operations Command Center</p>
      <h1 className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight text-balance">
        Research you can trace back to the source.
      </h1>
      <p className="mt-4 max-w-2xl text-ink-muted">
        Specialised agents run a durable workflow, every finding is verified against saved sources, and nothing leaves
        the system without your approval.
      </p>

      <ul className="mt-10 grid gap-3 sm:grid-cols-3">
        {PILLARS.map((pillar) => (
          <li key={pillar.title} className="rounded-lg border border-line bg-panel p-4">
            <h2 className="text-sm font-medium">{pillar.title}</h2>
            <p className="mt-1 text-sm text-ink-muted">{pillar.body}</p>
          </li>
        ))}
      </ul>

      <div className="mt-10 flex items-center gap-4">
        <Link
          href={signedIn ? '/dashboard' : '/sign-in'}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent/85"
        >
          {signedIn ? 'Open dashboard' : 'Sign in'}
        </Link>
        <span className="font-mono text-xs text-ink-subtle">Phase 1 · foundation</span>
      </div>
    </main>
  );
}
