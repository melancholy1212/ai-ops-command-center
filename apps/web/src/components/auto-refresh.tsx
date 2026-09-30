'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

const INTERVAL_MS = 3_000;

/**
 * Re-renders the page from the database every few seconds while the run can change on its own. It says
 * when the data shown was read, so a stalled refresh is visible rather than hidden.
 */
export function AutoRefresh({ active, readAt }: { active: boolean; readAt: string }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      router.refresh();
    }, INTERVAL_MS);
    return () => {
      clearInterval(id);
    };
  }, [active, router]);
  return (
    <p className="font-mono text-[11px] text-ink-subtle">
      {active ? 'Refreshing every 3 s' : 'Not refreshing: the run is not changing on its own'} · data as of {readAt}
    </p>
  );
}
