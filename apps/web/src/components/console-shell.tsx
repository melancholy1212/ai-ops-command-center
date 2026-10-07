import Link from 'next/link';
import type { ReactNode } from 'react';
import { MobileMenu } from '@/components/mobile-menu';
import { Button } from '@/components/ui/button';
import { cx } from '@/lib/cx';
import type { requireUser } from '@/lib/server/session';

export type Section = 'overview' | 'runs' | 'sources' | 'reports' | 'approvals' | 'activity' | 'settings';

// Sections without a page yet are listed as not built rather than linking to an empty page.
const NAV: readonly { group: string; items: readonly { key: Section; label: string; href: string | null }[] }[] = [
  {
    group: 'Workspace',
    items: [
      { key: 'overview', label: 'Overview', href: '/dashboard' },
      { key: 'runs', label: 'Runs', href: '/runs' },
      { key: 'sources', label: 'Sources', href: null },
      { key: 'reports', label: 'Reports', href: null },
    ],
  },
  {
    group: 'Operations',
    items: [
      { key: 'approvals', label: 'Approvals', href: null },
      { key: 'activity', label: 'Activity', href: null },
    ],
  },
  { group: 'System', items: [{ key: 'settings', label: 'Settings', href: null }] },
];

const SECTIONS = new Map(NAV.flatMap((g) => g.items).map((item) => [item.key, item]));

export interface Crumb {
  label: string;
  /** Ids and hashes are set in Geist Mono. */
  mono?: boolean | undefined;
}

type Session = Awaited<ReturnType<typeof requireUser>>;

/**
 * The application frame: a 216 px sidebar and a 56 px top bar on desktop, a top bar with a menu sheet below lg.
 * Pages render inside one left-aligned container, so the page's left edge lines up with the breadcrumb above it.
 */
export async function ConsoleShell({
  section,
  crumbs = [],
  session,
  children,
}: {
  section: Section;
  /** Locations below the section, outermost first; the last one is the current page. */
  crumbs?: readonly Crumb[];
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
  const workspace = membership?.workspace.name ?? 'No workspace';

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-elevated focus:px-3 focus:py-2 focus:text-small"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-dvh w-sidebar shrink-0 flex-col border-r border-line lg:flex">
        <div className="flex h-topbar shrink-0 items-center border-b border-line px-5">
          <Wordmark />
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-6">
          <NavList section={section} size="compact" />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-topbar shrink-0 items-center gap-4 border-b border-line bg-canvas px-4 sm:px-6 lg:px-8">
          <div className="flex shrink-0 items-center gap-4 lg:hidden">
            <Wordmark />
            <span aria-hidden="true" className="h-4 w-px bg-line" />
          </div>
          <Breadcrumb workspace={workspace} section={section} crumbs={crumbs} />
          <div className="ml-auto hidden items-center gap-3 lg:flex">
            <span className="text-small text-ink-muted">{session.email}</span>
            {membership ? (
              <span className="font-mono text-micro tracking-wider text-ink-subtle uppercase">{membership.role}</span>
            ) : null}
            <span aria-hidden="true" className="h-4 w-px bg-line" />
            <SignOut variant="ghost" size="sm" />
          </div>
          <div className="ml-auto lg:hidden">
            <MobileMenu>
              <NavList section={section} size="touch" />
              <div className="mt-8 space-y-4 border-t border-line pt-6">
                <div className="space-y-1 px-2">
                  <p className="text-body text-ink">{session.email}</p>
                  <p className="font-mono text-micro tracking-wider text-ink-subtle uppercase">
                    {workspace}
                    {membership ? ` · ${membership.role}` : ''}
                  </p>
                </div>
                <SignOut variant="secondary" size="lg" wide />
              </div>
            </MobileMenu>
          </div>
        </header>

        <main id="main" className="w-full max-w-page space-y-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function Wordmark() {
  return (
    <Link href="/dashboard" className="text-body font-semibold tracking-tight whitespace-nowrap text-ink">
      AI <span className="text-ink-subtle">/</span> OPS
    </Link>
  );
}

function NavList({ section, size }: { section: Section; size: 'compact' | 'touch' }) {
  const row = cx('relative flex items-center rounded-md px-2 text-body', size === 'compact' ? 'h-8' : 'h-11');
  return (
    <nav aria-label="Main" className="space-y-6">
      {NAV.map((group) => (
        <div key={group.group}>
          <p
            id={`nav-${size}-${group.group}`}
            className="px-2 pb-2 font-mono text-micro tracking-wider text-ink-subtle uppercase"
          >
            {group.group}
          </p>
          <ul aria-labelledby={`nav-${size}-${group.group}`} className="space-y-px">
            {group.items.map((item) => (
              <li key={item.key}>
                {item.href === null ? (
                  <span aria-disabled="true" className={cx(row, 'justify-between text-ink-disabled')}>
                    {item.label}
                    <span className="font-mono text-micro">not built</span>
                  </span>
                ) : item.key === section ? (
                  <Link href={item.href} aria-current="page" className={cx(row, 'bg-raised font-medium text-ink')}>
                    <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />
                    {item.label}
                  </Link>
                ) : (
                  <Link
                    href={item.href}
                    className={cx(row, 'text-ink-muted transition-colors duration-120 hover:bg-raised hover:text-ink')}
                  >
                    {item.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Breadcrumb({ workspace, section, crumbs }: { workspace: string; section: Section; crumbs: readonly Crumb[] }) {
  const current = SECTIONS.get(section);
  const separator = (
    <span aria-hidden="true" className="px-2 text-ink-disabled">
      /
    </span>
  );
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center text-small whitespace-nowrap">
        <li className="hidden min-w-0 items-center lg:flex">
          <span className="truncate text-ink-subtle">{workspace}</span>
          {separator}
        </li>
        <li className="flex min-w-0 items-center">
          {crumbs.length > 0 && current?.href ? (
            <Link href={current.href} className="text-ink-muted transition-colors duration-120 hover:text-ink">
              {current.label}
            </Link>
          ) : (
            <span aria-current="page" className="font-medium text-ink">
              {current?.label}
            </span>
          )}
        </li>
        {crumbs.map((crumb, i) => (
          <li key={i} className="flex min-w-0 items-center">
            {separator}
            <span
              aria-current={i === crumbs.length - 1 ? 'page' : undefined}
              className={cx(
                'truncate',
                i === crumbs.length - 1 ? 'font-medium text-ink' : 'text-ink-muted',
                crumb.mono && 'font-mono text-meta',
              )}
            >
              {crumb.label}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function SignOut({
  variant,
  size,
  wide = false,
}: {
  variant: 'ghost' | 'secondary';
  size: 'sm' | 'lg';
  wide?: boolean;
}) {
  return (
    <form action="/auth/sign-out" method="post">
      <Button type="submit" variant={variant} size={size} className={wide ? 'w-full' : undefined}>
        Sign out
      </Button>
    </form>
  );
}
