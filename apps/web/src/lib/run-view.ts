/**
 * View-model helpers for the run pages. Everything here maps persisted fields to display (docs/ui.md, the
 * honesty rule): unknown values are shown as unknown, never guessed.
 */
import type { ClaimStatus, RunStatus, TaskStatus, TaskType } from '@aoc/contracts';

export type Tone = 'slate' | 'cyan' | 'amber' | 'green' | 'red' | 'grey' | 'blue';
export interface StatusMeta {
  label: string;
  glyph: string;
  tone: Tone;
}

const TASK: Record<TaskStatus, StatusMeta> = {
  blocked: { label: 'Blocked', glyph: '◌', tone: 'grey' },
  ready: { label: 'Ready', glyph: '○', tone: 'slate' },
  running: { label: 'Running', glyph: '●', tone: 'cyan' },
  waiting_approval: { label: 'Waiting approval', glyph: '◆', tone: 'amber' },
  succeeded: { label: 'Succeeded', glyph: '✓', tone: 'green' },
  failed: { label: 'Failed', glyph: '✕', tone: 'red' },
  skipped: { label: 'Skipped', glyph: '–', tone: 'grey' },
  cancelled: { label: 'Cancelled', glyph: '–', tone: 'grey' },
};

const RUN: Record<RunStatus, StatusMeta> = {
  draft: { label: 'Draft', glyph: '◌', tone: 'grey' },
  planning: { label: 'Planning', glyph: '●', tone: 'cyan' },
  awaiting_plan_approval: { label: 'Awaiting plan approval', glyph: '◆', tone: 'amber' },
  running: { label: 'Running', glyph: '●', tone: 'cyan' },
  paused: { label: 'Paused', glyph: '‖', tone: 'amber' },
  completed: { label: 'Completed', glyph: '✓', tone: 'green' },
  failed: { label: 'Failed', glyph: '✕', tone: 'red' },
  cancelled: { label: 'Cancelled', glyph: '–', tone: 'grey' },
};

const CLAIM: Record<ClaimStatus, StatusMeta> = {
  proposed: { label: 'Proposed', glyph: '○', tone: 'grey' },
  grounded: { label: 'Grounded', glyph: '◎', tone: 'slate' },
  verified: { label: 'Verified', glyph: '✓', tone: 'green' },
  probable: { label: 'Probable', glyph: '◐', tone: 'blue' },
  contested: { label: 'Contested', glyph: '⇄', tone: 'amber' },
  stale: { label: 'Stale', glyph: '◷', tone: 'grey' },
  rejected: { label: 'Rejected', glyph: '✕', tone: 'red' },
};

const TABLES = { task: TASK, run: RUN, claim: CLAIM } as const;

export function statusMeta(kind: keyof typeof TABLES, status: string): StatusMeta {
  const table: Record<string, StatusMeta> = TABLES[kind];
  return table[status] ?? { label: `Unknown (${status})`, glyph: '?', tone: 'grey' };
}

/** Runs whose state can change without the viewer doing anything: the page refreshes while they last. */
export function isRunActive(status: string): boolean {
  return status === 'planning' || status === 'running';
}

export const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'skipped', 'cancelled']);

/** The stage view of docs/ui.md: stages in workflow order, each built from real task rows. */
export const STAGES: readonly { key: string; label: string; types: readonly TaskType[] }[] = [
  { key: 'plan', label: 'Plan', types: ['plan_run'] },
  { key: 'approve_plan', label: 'Approve plan', types: ['approve_plan'] },
  { key: 'discover', label: 'Discover', types: ['discover_companies'] },
  { key: 'profile', label: 'Profile / People', types: ['profile_company', 'find_people'] },
  { key: 'verify', label: 'Verify', types: ['verify_entity'] },
  { key: 'gap_fill', label: 'Gap-fill', types: ['gap_fill'] },
  { key: 'analyze', label: 'Analyze', types: ['rank_and_analyze'] },
  { key: 'outreach', label: 'Outreach', types: ['draft_outreach', 'approve_outreach'] },
  { key: 'report', label: 'Report', types: ['compile_report'] },
];

export interface StageSummary {
  key: string;
  label: string;
  total: number;
  counts: { status: string; count: number }[];
}

/** Stages that have tasks, in workflow order. A stage with no task rows yet has not been created. */
export function stageSummaries(tasks: readonly { type: string; status: string }[]): StageSummary[] {
  return STAGES.flatMap((stage) => {
    const own = tasks.filter((t) => (stage.types as readonly string[]).includes(t.type));
    if (own.length === 0) return [];
    const counts = new Map<string, number>();
    for (const t of own) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    const order = Object.keys(TASK);
    return [
      {
        key: stage.key,
        label: stage.label,
        total: own.length,
        counts: [...counts.entries()]
          .map(([status, count]) => ({ status, count }))
          .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)),
      },
    ];
  });
}

export function taskProgress(tasks: readonly { status: string }[]): { done: number; total: number } {
  return { done: tasks.filter((t) => TERMINAL_TASK_STATUSES.has(t.status)).length, total: tasks.length };
}

/** A task shows "running" only while its lease is live (docs/ui.md). */
export function leaseState(task: { status: string; lease_expires_at: string | null }, now: Date) {
  if (task.status !== 'running' || task.lease_expires_at === null) return null;
  return Date.parse(task.lease_expires_at) > now.getTime() ? 'live' : 'expired';
}

export function formatUsd(micros: number): string {
  const usd = micros / 1_000_000;
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

const integer = new Intl.NumberFormat('en-US');
export const formatCount = (n: number): string => integer.format(n);

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${String(h)}h ${String(m)}m`;
  if (m > 0) return `${String(m)}m ${String(s)}s`;
  return `${String(s)}s`;
}

/** Server-rendered times are UTC and say so, so server and browser never disagree. */
export function formatUtc(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return `${date.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

export const shortHash = (hash: string): string => hash.slice(0, 12);

export const humanize = (value: string): string => value.replaceAll('_', ' ').replace(/^company\./, '');

const str = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '?');

/** One line per run event. Unknown types are shown by name rather than hidden. */
export function describeEvent(type: string, data: unknown): string {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  switch (type) {
    case 'run.created':
      return 'Run created';
    case 'run.status_changed':
      return `Run ${humanize(str(d.from))} → ${humanize(str(d.to))}`;
    case 'plan.proposed':
      return `Plan revision ${str(d.revision)} proposed (${str(d.assumptions)} assumptions, ${str(d.openQuestions)} open questions)`;
    case 'task.created':
      return `Task ${humanize(str(d.taskType))} created (${humanize(str(d.cause))})`;
    case 'task.status_changed':
      return `Task ${humanize(str(d.taskType))} ${humanize(str(d.from))} → ${humanize(str(d.to))}`;
    case 'task.lease_expired':
      return `Task ${humanize(str(d.taskType))} lost its lease (attempt ${str(d.attempt)})`;
    case 'task.retry_scheduled': {
      const failure = (d.failure ?? {}) as Record<string, unknown>;
      return `Task ${humanize(str(d.taskType))} attempt ${str(d.attempt)} failed (${str(failure.code)}); retry scheduled`;
    }
    case 'approval.requested':
      return `Approval requested: ${humanize(str(d.approvalType))}`;
    case 'approval.decided':
      return `Approval ${humanize(str(d.approvalType))} ${str(d.decision)}`;
    case 'approval.invalidated':
      return `Approval ${humanize(str(d.approvalType))} invalidated: ${str(d.reason)}`;
    case 'budget.threshold_crossed':
      return `Budget ${str(d.percent)}% spent`;
    case 'artifact.created':
      return `Artifact ${humanize(str(d.kind))} v${str(d.version)} created`;
    default:
      return type;
  }
}
