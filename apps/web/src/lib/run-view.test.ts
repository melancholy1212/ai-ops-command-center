import { describe, expect, it } from 'vitest';
import {
  describeEvent,
  formatDuration,
  formatUsd,
  formatUtc,
  leaseState,
  stageSummaries,
  statusMeta,
  taskProgress,
} from './run-view';

describe('stageSummaries', () => {
  it('lists only stages with tasks, in workflow order, with counts by status', () => {
    const tasks = [
      { type: 'compile_report', status: 'blocked' },
      { type: 'verify_entity', status: 'succeeded' },
      { type: 'verify_entity', status: 'running' },
      { type: 'verify_entity', status: 'succeeded' },
      { type: 'plan_run', status: 'succeeded' },
    ];
    expect(stageSummaries(tasks)).toEqual([
      { key: 'plan', label: 'Plan', total: 1, counts: [{ status: 'succeeded', count: 1 }] },
      {
        key: 'verify',
        label: 'Verify',
        total: 3,
        counts: [
          { status: 'running', count: 1 },
          { status: 'succeeded', count: 2 },
        ],
      },
      { key: 'report', label: 'Report', total: 1, counts: [{ status: 'blocked', count: 1 }] },
    ]);
    expect(taskProgress(tasks)).toEqual({ done: 3, total: 5 });
  });
});

describe('display helpers', () => {
  it('never invents a status it does not know', () => {
    expect(statusMeta('task', 'succeeded')).toEqual({ label: 'Succeeded', glyph: '✓', tone: 'green' });
    expect(statusMeta('run', 'exploded')).toEqual({ label: 'Unknown (exploded)', glyph: '?', tone: 'grey' });
  });

  it('shows running only while the lease is live', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    expect(leaseState({ status: 'running', lease_expires_at: '2026-09-30T12:00:05Z' }, now)).toBe('live');
    expect(leaseState({ status: 'running', lease_expires_at: '2026-09-30T11:59:55Z' }, now)).toBe('expired');
    expect(leaseState({ status: 'ready', lease_expires_at: null }, now)).toBeNull();
  });

  it('formats money, durations and times', () => {
    expect(formatUsd(1_300)).toBe('$0.0013');
    expect(formatUsd(2_500_000)).toBe('$2.50');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(192_000)).toBe('3m 12s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
    expect(formatUtc('2026-09-30T12:31:05.123Z')).toBe('2026-09-30 12:31:05 UTC');
  });

  it('describes events from their data and names unknown ones', () => {
    expect(describeEvent('run.status_changed', { from: 'awaiting_plan_approval', to: 'running' })).toBe(
      'Run awaiting plan approval → running',
    );
    expect(
      describeEvent('task.retry_scheduled', {
        taskType: 'verify_entity',
        attempt: 1,
        failure: { code: 'LLM_TIMEOUT' },
      }),
    ).toBe('Task verify entity attempt 1 failed (LLM_TIMEOUT); retry scheduled');
    expect(describeEvent('something.new', {})).toBe('something.new');
    expect(describeEvent('run.status_changed', null)).toBe('Run ? → ?');
  });
});
