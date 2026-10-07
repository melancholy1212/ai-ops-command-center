'use client';

import { Menu, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { type ReactNode, useRef, useState } from 'react';

/**
 * Navigation below lg: a full-height sheet under the top bar. It is a <details>, so it opens without JavaScript;
 * with JavaScript it also closes on navigation and on Escape.
 */
export function MobileMenu({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const summary = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(pathname);
  if (path !== pathname) {
    setPath(pathname);
    setOpen(false);
  }

  return (
    <details
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        setOpen(false);
        summary.current?.focus();
      }}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('a')) setOpen(false);
      }}
    >
      <summary
        ref={summary}
        className="flex size-9 cursor-pointer list-none items-center justify-center rounded-md text-ink-muted transition-colors duration-120 hover:bg-raised hover:text-ink [&::-webkit-details-marker]:hidden"
      >
        {open ? (
          <X aria-hidden="true" size={18} strokeWidth={1.5} />
        ) : (
          <Menu aria-hidden="true" size={18} strokeWidth={1.5} />
        )}
        <span className="sr-only">Menu</span>
      </summary>
      <div className="fixed inset-x-0 top-topbar bottom-0 z-30 overflow-y-auto bg-canvas px-4 pt-6 pb-12 sm:px-6">
        {children}
      </div>
    </details>
  );
}
