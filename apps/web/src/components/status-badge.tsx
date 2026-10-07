import type { ReactNode } from 'react';
import { statusMeta, type StatusMeta, type StatusShape, type Tone } from '@/lib/run-view';

const TONE: Record<Tone, string> = {
  neutral: 'text-ink-muted',
  quiet: 'text-ink-subtle',
  info: 'text-info',
  success: 'text-ok',
  review: 'text-review',
  warning: 'text-warn',
  danger: 'text-danger',
};

// Drawn rather than typed, so every glyph has the same size and baseline whatever font is loaded.
const SHAPE: Record<StatusShape, ReactNode> = {
  dot: <circle cx="5" cy="5" r="3" fill="currentColor" stroke="none" />,
  ring: <circle cx="5" cy="5" r="3.25" />,
  dashed: <circle cx="5" cy="5" r="3.25" strokeDasharray="0 3.4" />,
  target: (
    <>
      <circle cx="5" cy="5" r="3.25" />
      <circle cx="5" cy="5" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  half: (
    <>
      <circle cx="5" cy="5" r="3.25" />
      <path d="M5 1.75a3.25 3.25 0 0 1 0 6.5Z" fill="currentColor" stroke="none" />
    </>
  ),
  diamond: <path d="M5 1.25 8.75 5 5 8.75 1.25 5Z" fill="currentColor" stroke="none" />,
  pause: <path d="M3.5 2.25v5.5M6.5 2.25v5.5" />,
  check: <path d="M1.75 5.25 4 7.5 8.25 2.75" />,
  cross: <path d="M2.5 2.5 7.5 7.5M7.5 2.5 2.5 7.5" />,
  triangle: <path d="M5 1.5 8.75 8.25H1.25Z" />,
  dash: <path d="M2.25 5h5.5" />,
};

/**
 * A status as a glyph and a label, never colour alone (docs/ui.md). Compact on purpose: it sits in table cells and
 * headers without a box around it. Pass `meta` when the label is derived (runStatusMeta), else kind and status.
 */
export function StatusBadge(
  props: ({ kind: 'task' | 'run' | 'claim'; status: string } | { meta: StatusMeta }) & {
    note?: string | undefined;
  },
) {
  const meta = 'meta' in props ? props.meta : statusMeta(props.kind, props.status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono text-micro tracking-wider whitespace-nowrap uppercase ${TONE[meta.tone]}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 10 10"
        className="size-2.5 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {SHAPE[meta.shape]}
      </svg>
      {meta.label}
      {props.note ? <span className="tracking-normal text-ink-subtle normal-case">· {props.note}</span> : null}
    </span>
  );
}
