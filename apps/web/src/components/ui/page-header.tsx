import type { ReactNode } from 'react';

/** The top of a page: its title, an optional line of context, and the page's own actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="min-w-0 max-w-3xl space-y-2">
        <h1 className="text-title-mobile font-medium text-ink lg:text-title">{title}</h1>
        {description ? <p className="text-body text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
