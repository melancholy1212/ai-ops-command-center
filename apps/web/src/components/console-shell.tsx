import Link from 'next/link';
import type { ReactNode } from 'react';
import type { requireUser } from '@/lib/server/session';

// Sections from docs/ui.md. Unbuilt ones are shown as unavailable rather than linking to empty pages.
const NAV: readonly { label: string; href: string | null }[] = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'Runs', href: '/runs' },
  { label: 'Projects', href: null },
  { label: 'Agents', href: null },
  { label: 'MCP', href: null },
  { label: 'Evidence', href: null },
  { label: 'Approvals', href: null },
  { label: 'Settings', href: null },
];

type Session = Awaited<ReturnType<typeof requireUser>>;

export async function ConsoleShell({
  active,
  session,
  children,
}: {
  active: string;
  session: Session;
  children: ReactNode;
}) {
  // Row-level security limits this to the signed-in user's workspaces.
  const { data: memberships } = await session.supabase
    .from('workspace_members')
    .select('role, workspace:workspaces(name)')
    .eq('user_id', session.userId)
    .limit(1);
  const membership = memberships?.[0];

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-56 shrink-0 border-r border-line bg-panel px-3 py-4 md:block">
        <p className="px-2 font-mono text-[11px] tracking-[0.18em] text-accent-cyan uppercase">AOC</p>
        <nav aria-label="Main" className="mt-6 space-y-0.5 text-sm">
          {NAV.map((item) =>
            item.href === null ? (
              <span
                key={item.label}
                aria-disabled="true"
                className="flex items-center justify-between rounded-md px-2 py-1.5 text-ink-subtle"
              >
                {item.label}
                <span className="font-mono text-[10px]">not built</span>
              </span>
            ) : (
              <Link
                key={item.label}
                href={item.href}
                aria-current={item.label === active ? 'page' : undefined}
                className={`block rounded-md px-2 py-1.5 ${item.label === active ? 'bg-raised text-ink' : 'text-ink-muted hover:text-ink'}`}
              >
                {item.label}
              </Link>
            ),
          )}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between border-b border-line px-6 py-3">
          <div className="text-sm">
            <span className="text-ink">{membership?.workspace.name ?? 'No workspace'}</span>
            {membership ? (
              <span className="ml-2 rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
                {membership.role}
              </span>
            ) : null}
          </div>
          <form action="/auth/sign-out" method="post" className="flex items-center gap-3 text-sm">
            <span className="text-ink-muted">{session.email}</span>
            <button type="submit" className="rounded-md border border-line px-3 py-1 text-ink-muted hover:text-ink">
              Sign out
            </button>
          </form>
        </header>
        <main className="space-y-6 p-6">{children}</main>
      </div>
    </div>
  );
}
