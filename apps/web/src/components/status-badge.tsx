import { statusMeta, type Tone } from '@/lib/run-view';

const TONE: Record<Tone, string> = {
  slate: 'border-line text-ink-muted',
  cyan: 'border-accent-cyan/40 text-accent-cyan',
  amber: 'border-warn/40 text-warn',
  green: 'border-ok/40 text-ok',
  red: 'border-danger/40 text-danger',
  grey: 'border-line text-ink-subtle',
  blue: 'border-accent/40 text-accent',
};

/** Status is always a glyph and a label, never colour alone (docs/ui.md). */
export function StatusBadge({
  kind,
  status,
  note,
}: {
  kind: 'task' | 'run' | 'claim';
  status: string;
  note?: string | undefined;
}) {
  const meta = statusMeta(kind, status);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap ${TONE[meta.tone]}`}
    >
      <span aria-hidden="true">{meta.glyph}</span>
      {meta.label}
      {note ? <span className="text-ink-subtle">· {note}</span> : null}
    </span>
  );
}
