/**
 * View-model helpers for the run pages. Everything here maps persisted fields to display (docs/ui.md, the
 * honesty rule): unknown values are shown as unknown, never guessed.
 */
import type { ClaimStatus, RunStatus, TaskStatus, TaskType } from '@aoc/contracts';

/** Semantic colour of a status (SKILL.md status colours). Quiet is for states that need no attention. */
export type Tone = 'neutral' | 'quiet' | 'info' | 'success' | 'review' | 'warning' | 'danger';
/** The glyph drawn beside the label, so a status never depends on colour alone. */
export type StatusShape =
  'dot' | 'ring' | 'dashed' | 'target' | 'half' | 'diamond' | 'pause' | 'check' | 'cross' | 'triangle' | 'dash';
export interface StatusMeta {
  label: string;
  shape: StatusShape;
  tone: Tone;
}

// Labels use the SKILL.md vocabulary (Queued, Awaiting review, Completed, ...) where the stored state means exactly
// that, and keep their own word where it does not (Draft, Paused, Skipped, Cancelled). A blocked task is waiting on
// its dependencies, which is normal, so it is quiet rather than a warning.
const TASK: Record<TaskStatus, StatusMeta> = {
  blocked: { label: 'Blocked', shape: 'dashed', tone: 'quiet' },
  ready: { label: 'Queued', shape: 'ring', tone: 'neutral' },
  running: { label: 'Running', shape: 'dot', tone: 'info' },
  waiting_approval: { label: 'Awaiting review', shape: 'diamond', tone: 'review' },
  succeeded: { label: 'Completed', shape: 'check', tone: 'success' },
  failed: { label: 'Failed', shape: 'cross', tone: 'danger' },
  skipped: { label: 'Skipped', shape: 'dash', tone: 'quiet' },
  cancelled: { label: 'Cancelled', shape: 'dash', tone: 'quiet' },
};

const RUN: Record<RunStatus, StatusMeta> = {
  draft: { label: 'Draft', shape: 'dashed', tone: 'quiet' },
  planning: { label: 'Planning', shape: 'dot', tone: 'info' },
  awaiting_plan_approval: { label: 'Awaiting review', shape: 'diamond', tone: 'review' },
  running: { label: 'Running', shape: 'dot', tone: 'info' },
  paused: { label: 'Paused', shape: 'pause', tone: 'warning' },
  completed: { label: 'Completed', shape: 'check', tone: 'success' },
  failed: { label: 'Failed', shape: 'cross', tone: 'danger' },
  cancelled: { label: 'Cancelled', shape: 'dash', tone: 'quiet' },
};

const CLAIM: Record<ClaimStatus, StatusMeta> = {
  proposed: { label: 'Proposed', shape: 'ring', tone: 'quiet' },
  grounded: { label: 'Grounded', shape: 'target', tone: 'neutral' },
  verified: { label: 'Verified', shape: 'check', tone: 'success' },
  probable: { label: 'Probable', shape: 'half', tone: 'info' },
  contested: { label: 'Contested', shape: 'triangle', tone: 'warning' },
  stale: { label: 'Stale', shape: 'dashed', tone: 'quiet' },
  rejected: { label: 'Rejected', shape: 'cross', tone: 'danger' },
};

const TABLES = { task: TASK, run: RUN, claim: CLAIM } as const;

export function statusMeta(kind: keyof typeof TABLES, status: string): StatusMeta {
  const table: Record<string, StatusMeta> = TABLES[kind];
  return table[status] ?? { label: `Unknown (${status})`, shape: 'dashed', tone: 'quiet' };
}

/**
 * A running run named for its stage when that is exact: Discovering while every task holding a live lease is a
 * discovery task, Verifying while every one is a verification task. Otherwise the stored status's own label.
 */
export function runStatusMeta(
  status: string,
  tasks: readonly { type: string; status: string; lease_expires_at: string | null }[],
  now: Date,
): StatusMeta {
  const meta = statusMeta('run', status);
  if (status !== 'running') return meta;
  const live = new Set(tasks.filter((t) => leaseState(t, now) === 'live').map((t) => t.type));
  if (live.size !== 1) return meta;
  if (live.has('discover_companies')) return { ...meta, label: 'Discovering' };
  if (live.has('verify_entity')) return { ...meta, label: 'Verifying' };
  return meta;
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
