import type { Failure, TaskStatus, TaskType } from '@aoc/contracts';
import { describe, expect, it } from 'vitest';
import { deriveRunStatus, type RunStatusInput } from './run-status';

const now = new Date('2026-09-30T12:00:00Z');
const failure: Failure = {
  code: 'LLM_REFUSAL',
  class: 'permanent',
  message: 'refused',
  retryable: false,
  occurredAt: now.toISOString(),
};

function run(tasks: [TaskType, TaskStatus][], flags: Partial<RunStatusInput> = {}): RunStatusInput {
  return {
    cancelRequested: false,
    pauseRequested: false,
    budgetBlocked: false,
    tasks: tasks.map(([type, status]) => ({ type, status, lastFailure: status === 'failed' ? failure : null })),
    ...flags,
  };
}

const status = (input: RunStatusInput) => {
  const d = deriveRunStatus(input, now);
  return d.pauseReason ? `${d.status}:${d.pauseReason}` : d.status;
};

describe('deriveRunStatus: each rule', () => {
  it('draft before any task exists', () => {
    expect(status(run([]))).toBe('draft');
  });

  it('planning while the plan task is ready or running', () => {
    expect(
      status(
        run([
          ['plan_run', 'ready'],
          ['approve_plan', 'blocked'],
          ['discover_companies', 'blocked'],
        ]),
      ),
    ).toBe('planning');
    expect(
      status(
        run([
          ['plan_run', 'running'],
          ['approve_plan', 'blocked'],
        ]),
      ),
    ).toBe('planning');
  });

  it('awaiting plan approval while the gate is ready, running or waiting', () => {
    for (const gate of ['ready', 'running', 'waiting_approval'] as const) {
      expect(
        status(
          run([
            ['plan_run', 'succeeded'],
            ['approve_plan', gate],
            ['discover_companies', 'blocked'],
          ]),
        ),
      ).toBe('awaiting_plan_approval');
    }
  });

  it('running once work is under way', () => {
    expect(
      status(
        run([
          ['plan_run', 'succeeded'],
          ['approve_plan', 'succeeded'],
          ['discover_companies', 'running'],
        ]),
      ),
    ).toBe('running');
  });

  it('a task waiting to retry (ready) keeps the run running', () => {
    expect(
      status(
        run([
          ['approve_plan', 'succeeded'],
          ['profile_company', 'ready'],
          ['rank_and_analyze', 'blocked'],
        ]),
      ),
    ).toBe('running');
  });

  it('paused awaiting approval when nothing can run and a gate waits', () => {
    expect(
      status(
        run([
          ['rank_and_analyze', 'succeeded'],
          ['approve_outreach', 'waiting_approval'],
          ['compile_report', 'blocked'],
        ]),
      ),
    ).toBe('paused:awaiting_approval');
  });

  it('not paused while other work can still run next to a waiting gate', () => {
    expect(
      status(
        run([
          ['approve_outreach', 'waiting_approval'],
          ['draft_outreach', 'running'],
        ]),
      ),
    ).toBe('running');
  });

  it('completed when the final task succeeded', () => {
    expect(
      status(
        run([
          ['rank_and_analyze', 'succeeded'],
          ['compile_report', 'succeeded'],
        ]),
      ),
    ).toBe('completed');
  });

  it('failed when a fatal task failed, carrying its failure', () => {
    const d = deriveRunStatus(
      run([
        ['plan_run', 'failed'],
        ['approve_plan', 'blocked'],
      ]),
      now,
    );
    expect(d).toEqual({ status: 'failed', pauseReason: null, failure });
  });

  it('a non-fatal failure does not fail the run', () => {
    expect(
      status(
        run([
          ['profile_company', 'failed'],
          ['find_people', 'skipped'],
          ['rank_and_analyze', 'ready'],
        ]),
      ),
    ).toBe('running');
  });

  it('failed when every task is terminal but the final task never ran', () => {
    const d = deriveRunStatus(
      run([
        ['profile_company', 'failed'],
        ['compile_report', 'skipped'],
      ]),
      now,
    );
    expect(d.status).toBe('failed');
    expect(d.failure?.code).toBe('DEPENDENCY_FAILED');
  });

  it('cancelled as soon as cancellation is requested', () => {
    expect(status(run([['discover_companies', 'running']], { cancelRequested: true }))).toBe('cancelled');
  });

  it('paused by the user', () => {
    expect(status(run([['discover_companies', 'ready']], { pauseRequested: true }))).toBe('paused:user_requested');
  });

  it('paused for budget', () => {
    expect(status(run([['discover_companies', 'ready']], { budgetBlocked: true }))).toBe('paused:budget_exhausted');
  });
});

describe('deriveRunStatus: precedence', () => {
  it('cancel beats everything, including a completed final task', () => {
    expect(status(run([['compile_report', 'succeeded']], { cancelRequested: true }))).toBe('cancelled');
  });

  it('a fatal failure beats pause and budget flags', () => {
    expect(status(run([['discover_companies', 'failed']], { pauseRequested: true, budgetBlocked: true }))).toBe(
      'failed',
    );
  });

  it('completion beats pause', () => {
    expect(status(run([['compile_report', 'succeeded']], { pauseRequested: true }))).toBe('completed');
  });

  it('a user pause beats a budget pause, which beats awaiting plan approval', () => {
    const tasks: [TaskType, TaskStatus][] = [['approve_plan', 'waiting_approval']];
    expect(status(run(tasks, { pauseRequested: true, budgetBlocked: true }))).toBe('paused:user_requested');
    expect(status(run(tasks, { budgetBlocked: true }))).toBe('paused:budget_exhausted');
    expect(status(run(tasks))).toBe('awaiting_plan_approval');
  });

  it('a rejected plan followed by a new revision is planning again', () => {
    expect(
      status(
        run([
          ['plan_run', 'succeeded'],
          ['approve_plan', 'failed'],
          ['plan_run', 'ready'],
          ['approve_plan', 'blocked'],
          ['discover_companies', 'blocked'],
        ]),
      ),
    ).toBe('planning');
  });
});
