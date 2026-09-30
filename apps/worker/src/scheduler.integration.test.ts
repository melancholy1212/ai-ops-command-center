// The scheduler against the local database: competing workers, a worker killed mid-task, a stalled
// worker that lost its lease, shutdown, cancellation, timeouts and rejected results.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@aoc/config/logger';
import type { CompanyId, RunId, TaskStatus } from '@aoc/contracts';
import { cancelRun, createRun, DEFAULT_RUN_BUDGET, recoverExpiredLeases, startRun, TaskFailure } from '@aoc/core';
import { createTasks, lockRun, settleRun } from '@aoc/core/testing';
import { withWorkspace, type Database } from '@aoc/db';
import { createTestHarness, type TestHarness, type TestTenant } from '@aoc/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createScheduler, type HandlerRegistry, type Scheduler, type SchedulerOptions } from './scheduler';

const silent = createLogger('worker-test', 'silent');
const NO_BACKOFF = { baseMs: 0, maxMs: 0, jitterMs: 0 };

let h: TestHarness;
let tenant: TestTenant;
const schedulers: Scheduler[] = [];

beforeAll(async () => {
  h = await createTestHarness();
  tenant = await h.createTenant('worker');
});

afterEach(async () => {
  await Promise.all(schedulers.splice(0).map((s) => s.stop()));
  await h.admin.query('delete from public.runs where workspace_id = $1', [tenant.workspaceId]);
});

afterAll(async () => {
  await h.close();
});

/** A started run plus `count` independent profile_company tasks, all ready. */
async function seedRun(count: number): Promise<RunId> {
  const user = { userId: tenant.userId };
  const runId = await createRun(h.db, user, tenant.workspaceId, {
    projectId: tenant.projectId,
    objective: 'Scheduler integration test run with independent tasks.',
    budget: DEFAULT_RUN_BUDGET,
  });
  await startRun(h.db, user, tenant.workspaceId, { runId });
  const actor = { kind: 'system' } as const;
  await withWorkspace(h.db, tenant.workspaceId, async (tx) => {
    const run = await lockRun(tx, runId);
    const tasks = Array.from({ length: count }, (_, i) => {
      const companyId = randomUUID() as CompanyId;
      return {
        ref: `p${String(i)}`,
        type: 'profile_company' as const,
        input: { type: 'profile_company' as const, companyId },
        idempotencyKey: `profile_company:${companyId}`,
      };
    });
    await createTasks(tx, run, { tasks }, null, 'expansion', actor);
    await settleRun(tx, run, actor);
  });
  return runId;
}

function scheduler(handlers: HandlerRegistry, overrides: Partial<SchedulerOptions> = {}, db: Database = h.db) {
  const s = createScheduler({
    db,
    workerId: `w-${randomUUID().slice(0, 8)}`,
    handlers,
    log: silent,
    concurrency: 4,
    leaseSeconds: 10,
    heartbeatIntervalMs: 1_000,
    idlePollMs: 50,
    reapIntervalMs: 250,
    shutdownGraceMs: 2_000,
    retryPolicy: NO_BACKOFF,
    ...overrides,
  });
  schedulers.push(s);
  s.start();
  return s;
}

async function profileTasks(runId: RunId) {
  const { rows } = await h.admin.query<{
    id: string;
    status: TaskStatus;
    attempt: number;
    lease_token: string | null;
    lease_owner: string | null;
    last_failure: { code: string } | null;
    output: { summary: Record<string, unknown> } | null;
  }>(`select * from public.tasks where run_id = $1 and type = 'profile_company' order by created_at`, [runId]);
  return rows;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const allTasks = (runId: RunId, status: TaskStatus) => async () =>
  (await profileTasks(runId)).every((t) => t.status === status);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('scheduler', () => {
  it('runs every task exactly once across competing workers and respects the per-run limit', async () => {
    const runId = await seedRun(24);
    const calls = new Map<string, number>();
    let inFlight = 0;
    let maxInFlight = 0;
    const handlers: HandlerRegistry = {
      profile_company: async ({ claim }) => {
        calls.set(claim.taskId, (calls.get(claim.taskId) ?? 0) + 1);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(20 + Math.random() * 40);
        inFlight -= 1;
        return { kind: 'succeeded', summary: { worker: claim.leaseToken.slice(0, 8) } };
      },
    };
    for (let i = 0; i < 3; i += 1) scheduler(handlers, {}, h.connect(`competing-${String(i)}`, 8));

    await waitFor(allTasks(runId, 'succeeded'), 30_000, 'all tasks to succeed');
    const tasks = await profileTasks(runId);
    expect(tasks).toHaveLength(24);
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
    expect(calls.size).toBe(24);
    expect(tasks.every((t) => t.attempt === 1 && t.lease_token === null)).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('recovers the task of a worker killed with SIGKILL mid-task', async () => {
    const runId = await seedRun(1);
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./testing/crash-worker.ts', import.meta.url))],
      { env: { ...process.env, DATABASE_URL: h.serviceUrl, WORKER_ID: 'crash-child' }, stdio: 'ignore' },
    );
    try {
      await waitFor(
        async () => (await profileTasks(runId))[0]?.lease_owner === 'crash-child',
        20_000,
        'the child to claim the task',
      );
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }

    scheduler({ profile_company: () => Promise.resolve({ kind: 'succeeded', summary: { recovered: true } }) });
    await waitFor(allTasks(runId, 'succeeded'), 15_000, 'the task to be recovered and completed');
    const [task] = await profileTasks(runId);
    expect(task?.attempt).toBe(2);
    expect(task?.output?.summary).toEqual({ recovered: true });
    const { rows } = await h.admin.query<{ data: { workerId: string } }>(
      `select data from public.run_events where run_id = $1 and type = 'task.lease_expired'`,
      [runId],
    );
    expect(rows.map((r) => r.data.workerId)).toEqual(['crash-child']);
  });

  it('stops a stalled worker that lost its lease and ignores its late result', async () => {
    const runId = await seedRun(1);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let stalledSignal: AbortSignal | undefined;
    let lateWrite = false;
    // Worker A never reaps, and its first heartbeat comes 3 s after the claim: until then it behaves
    // like a paused process, which is when the takeover below happens.
    scheduler(
      {
        profile_company: async ({ signal }) => {
          stalledSignal = signal;
          await gate;
          return {
            kind: 'succeeded',
            write: () => {
              lateWrite = true;
              return Promise.resolve({});
            },
          };
        },
      },
      { reapIntervalMs: 3_600_000, leaseSeconds: 20, heartbeatIntervalMs: 3_000 },
    );
    await waitFor(async () => (await profileTasks(runId))[0]?.status === 'running', 5_000, 'worker A to start');

    // A's lease expires during the pause and is taken over: its lease token is no longer valid.
    await h.admin.query(
      `update public.tasks set lease_expires_at = now() - interval '1 second' where run_id = $1 and type = 'profile_company'`,
      [runId],
    );
    // A local `pnpm dev` worker may recover it first; either way the lease must have changed hands.
    await recoverExpiredLeases(h.db, 'test-reaper', { kind: 'system' }, { retryPolicy: NO_BACKOFF });
    const [takenOver] = await profileTasks(runId);
    expect([takenOver?.status, takenOver?.last_failure?.code]).toEqual(['ready', 'LEASE_EXPIRED']);
    scheduler({ profile_company: () => Promise.resolve({ kind: 'succeeded', summary: { by: 'B' } }) });
    await waitFor(allTasks(runId, 'succeeded'), 5_000, 'worker B to complete the task');
    await waitFor(() => Promise.resolve(stalledSignal?.aborted === true), 6_000, "worker A's heartbeat to notice");
    expect(stalledSignal?.reason).toBe('lease_lost');

    release();
    await sleep(200);
    expect(lateWrite).toBe(false);
    const [task] = await profileTasks(runId);
    expect([task?.attempt, task?.output?.summary]).toEqual([2, { by: 'B' }]);
  }, 20_000);

  it('never runs more tasks at once than its own concurrency', async () => {
    const runId = await seedRun(8);
    let inFlight = 0;
    let maxInFlight = 0;
    scheduler(
      {
        profile_company: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await sleep(50);
          inFlight -= 1;
          return { kind: 'succeeded' };
        },
      },
      { concurrency: 2 },
    );
    await waitFor(allTasks(runId, 'succeeded'), 10_000, 'all tasks to succeed');
    expect(maxInFlight).toBe(2);
  });

  it('lets a handler finish within the shutdown grace period', async () => {
    const runId = await seedRun(1);
    const s = scheduler({
      profile_company: async () => {
        await sleep(300);
        return { kind: 'succeeded' };
      },
    });
    await waitFor(async () => (await profileTasks(runId))[0]?.status === 'running', 5_000, 'the task to start');
    await s.stop();
    expect((await profileTasks(runId))[0]?.status).toBe('succeeded');
  });

  it('hands a task back without counting the attempt when the grace period runs out', async () => {
    const runId = await seedRun(1);
    const s = scheduler({ profile_company: () => new Promise(() => undefined) }, { shutdownGraceMs: 200 });
    await waitFor(async () => (await profileTasks(runId))[0]?.status === 'running', 5_000, 'the task to start');
    await s.stop();
    const [task] = await profileTasks(runId);
    expect([task?.status, task?.attempt, task?.lease_token]).toEqual(['ready', 0, null]);
    expect(s.activeTasks).toBe(0);
  });

  it('stops a running handler when its run is cancelled', async () => {
    const runId = await seedRun(1);
    let reason: unknown;
    scheduler({
      profile_company: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reason = signal.reason;
            reject(new Error('aborted'));
          });
        }),
    });
    await waitFor(async () => (await profileTasks(runId))[0]?.status === 'running', 5_000, 'the task to start');
    await cancelRun(h.db, { userId: tenant.userId }, tenant.workspaceId, { runId, reason: 'Test cancel.' });
    await waitFor(allTasks(runId, 'cancelled'), 5_000, 'the task to be cancelled');
    expect(reason).toBe('cancelled');
  });

  it('fails attempts that run past the time limit and retries them', async () => {
    const runId = await seedRun(1);
    scheduler({ profile_company: () => new Promise(() => undefined) }, { maxAttemptMs: 300 });
    await waitFor(allTasks(runId, 'failed'), 10_000, 'the task to fail');
    const [task] = await profileTasks(runId);
    expect([task?.attempt, task?.last_failure?.code]).toEqual([2, 'TASK_TIMEOUT']);
  });

  it('records handler errors by failure class', async () => {
    const runId = await seedRun(2);
    const [first] = await profileTasks(runId);
    const calls = new Map<string, number>();
    scheduler({
      profile_company: ({ claim }) => {
        calls.set(claim.taskId, (calls.get(claim.taskId) ?? 0) + 1);
        if (claim.taskId === first?.id) throw new TaskFailure('TOOL_FAILED', 'registry offline');
        throw new Error('bug in handler');
      },
    });
    await waitFor(allTasks(runId, 'failed'), 10_000, 'both tasks to fail');
    const tasks = await profileTasks(runId);
    const permanent = tasks.find((t) => t.id === first?.id);
    const bug = tasks.find((t) => t.id !== first?.id);
    expect([permanent?.attempt, permanent?.last_failure?.code]).toEqual([1, 'TOOL_FAILED']);
    expect([bug?.attempt, bug?.last_failure?.code]).toEqual([2, 'INTERNAL_ERROR']);
  });

  it('treats a result the engine rejects as a failed attempt', async () => {
    const runId = await seedRun(1);
    scheduler({
      profile_company: ({ claim }) =>
        Promise.resolve({
          kind: 'succeeded',
          expand: {
            tasks: [],
            // The task itself is running, so it cannot gain dependencies: the engine refuses.
            addDependencies: [{ taskId: claim.taskId, dependsOn: [{ taskId: claim.taskId, mode: 'hard' }] }],
          },
        }),
    });
    await waitFor(allTasks(runId, 'failed'), 10_000, 'the task to fail');
    const [task] = await profileTasks(runId);
    expect([task?.attempt, task?.last_failure?.code]).toEqual([2, 'INTERNAL_ERROR']);
  });
});
