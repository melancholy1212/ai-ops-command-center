/**
 * The scheduler: claims ready tasks, runs their handlers under a heartbeated lease, and records every
 * outcome through the engine's fenced transitions. It never changes workflow state itself.
 *
 *   claim ─► startAttempt ─► handler (heartbeat every interval) ─► complete | fail | cancel | release
 *
 * Handlers get an AbortSignal. It fires when the lease is lost, the run is cancelled, the attempt
 * runs past its time limit, or the worker shuts down; `signal.reason` says which. The scheduler does
 * not wait for a handler that ignores it: the outcome is recorded at once, and the lease token makes
 * any late result from that handler fail to commit.
 */
import type { Logger } from '@aoc/config/logger';
import { TaskInput, type Actor, type TaskType } from '@aoc/contracts';
import {
  BudgetExhaustedError,
  cancelTask,
  claimNextTask,
  completeTask,
  DEFAULT_RETRY_POLICY,
  failTaskAttempt,
  heartbeat,
  LeaseLostError,
  makeFailure,
  recoverExpiredLeases,
  releaseForBudget,
  releaseTask,
  startAttempt,
  toFailure,
  type ClaimedTask,
  type RetryPolicy,
  type StartResult,
  type TaskOutcome,
} from '@aoc/core';
import type { Database } from '@aoc/db';

export type StopReason = 'lease_lost' | 'cancelled' | 'timeout' | 'shutdown';

export interface HandlerContext {
  claim: ClaimedTask;
  input: TaskInput;
  db: Database;
  signal: AbortSignal;
  log: Logger;
}

export type TaskHandler = (context: HandlerContext) => Promise<TaskOutcome>;
export type HandlerRegistry = Partial<Record<TaskType, TaskHandler>>;

export interface SchedulerOptions {
  db: Database;
  workerId: string;
  /** Only task types listed here are claimed. */
  handlers: HandlerRegistry;
  log: Logger;
  /** Tasks this worker runs at the same time. */
  concurrency?: number;
  leaseSeconds?: number;
  /** At most half the lease, so one missed heartbeat does not lose it. */
  heartbeatIntervalMs?: number;
  /** One attempt's time limit; past it the attempt fails with TASK_TIMEOUT and may be retried. */
  maxAttemptMs?: number;
  idlePollMs?: number;
  reapIntervalMs?: number;
  /** How long `stop()` lets running handlers finish before handing their tasks back. */
  shutdownGraceMs?: number;
  retryPolicy?: RetryPolicy;
}

export interface Scheduler {
  start(): void;
  /** Stops claiming, lets running handlers finish within the grace period, hands back the rest. */
  stop(): Promise<void>;
  readonly activeTasks: number;
}

interface ActiveTask {
  claim: ClaimedTask;
  controller: AbortController;
  done: Promise<void>;
}

type HandlerResult =
  | { kind: 'outcome'; outcome: TaskOutcome }
  | { kind: 'error'; error: unknown }
  | { kind: 'stopped'; reason: StopReason };

export function createScheduler(options: SchedulerOptions): Scheduler {
  const config = {
    concurrency: 4,
    leaseSeconds: 60,
    heartbeatIntervalMs: 15_000,
    maxAttemptMs: 20 * 60_000,
    idlePollMs: 1_000,
    reapIntervalMs: 15_000,
    shutdownGraceMs: 10_000,
    retryPolicy: DEFAULT_RETRY_POLICY,
    ...options,
  };
  if (config.concurrency < 1) throw new Error('concurrency must be at least 1');
  if (config.heartbeatIntervalMs * 2 > config.leaseSeconds * 1000) {
    throw new Error('heartbeatIntervalMs must be at most half of leaseSeconds');
  }

  const { db, workerId, log } = config;
  const actor: Actor = { kind: 'worker', workerId };
  const taskTypes = Object.keys(config.handlers) as TaskType[];
  const active = new Map<string, ActiveTask>();
  let running = false;
  // Read through a function: stop() flips the flag while the loop awaits, which narrowing cannot see.
  const isRunning = () => running;
  let loop: Promise<void> = Promise.resolve();
  let reapTimer: NodeJS.Timeout | undefined;
  let reaping = false;
  let wake: (() => void) | undefined;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
      wake = done;
    });

  async function claimLoop(): Promise<void> {
    while (isRunning()) {
      if (active.size >= config.concurrency || taskTypes.length === 0) {
        await sleep(config.idlePollMs);
        continue;
      }
      let claim: ClaimedTask | null;
      try {
        claim = await claimNextTask(db, { workerId, leaseSeconds: config.leaseSeconds, taskTypes });
      } catch (error) {
        log.error({ err: error }, 'claim failed');
        await sleep(config.idlePollMs);
        continue;
      }
      if (!claim) {
        await sleep(config.idlePollMs);
        continue;
      }
      if (!isRunning()) {
        // stop() was called while this claim was in flight.
        await releaseTask(db, claim, 'worker shutting down', actor).catch((error: unknown) => {
          log.warn({ err: error, taskId: claim.taskId }, 'could not release a task claimed during shutdown');
        });
        return;
      }
      track(claim);
    }
  }

  function track(claim: ClaimedTask) {
    const controller = new AbortController();
    const taskLog = log.child({
      workspaceId: claim.workspaceId,
      runId: claim.runId,
      taskId: claim.taskId,
      taskType: claim.taskType,
      attempt: claim.attempt,
    });
    const done = execute(claim, controller, taskLog)
      .catch((error: unknown) => {
        taskLog.error({ err: error }, 'task outcome could not be recorded; the lease will expire and be recovered');
      })
      .finally(() => {
        active.delete(claim.taskId);
        wake?.();
      });
    active.set(claim.taskId, { claim, controller, done });
  }

  async function execute(claim: ClaimedTask, controller: AbortController, taskLog: Logger): Promise<void> {
    let started: StartResult;
    try {
      started = await startAttempt(db, claim, actor);
    } catch (error) {
      if (error instanceof LeaseLostError) return;
      throw error;
    }
    if (!started.started) {
      taskLog.info({ reason: started.reason }, 'attempt not started');
      return;
    }

    const stop = (reason: StopReason) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    let beating = false;
    const beat = setInterval(() => {
      if (beating) return;
      beating = true;
      heartbeat(db, claim, config.leaseSeconds)
        .then((state) => {
          if (state === 'lost') stop('lease_lost');
          if (state === 'cancelled') stop('cancelled');
        })
        .catch((error: unknown) => {
          taskLog.warn({ err: error }, 'heartbeat failed');
        })
        .finally(() => (beating = false));
    }, config.heartbeatIntervalMs);
    const deadline = setTimeout(() => {
      stop('timeout');
    }, config.maxAttemptMs);

    const stopped = new Promise<HandlerResult>((resolve) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          resolve({ kind: 'stopped', reason: controller.signal.reason as StopReason });
        },
        { once: true },
      );
    });
    const handler = config.handlers[claim.taskType];
    const handled = (async (): Promise<HandlerResult> => {
      if (!handler) throw new Error(`No handler for ${claim.taskType}`);
      const input = TaskInput.parse(started.task.input);
      return { kind: 'outcome', outcome: await handler({ claim, input, db, signal: controller.signal, log: taskLog }) };
    })().catch((error: unknown): HandlerResult => ({ kind: 'error', error }));

    const result = await Promise.race([handled, stopped]);
    clearInterval(beat);
    clearTimeout(deadline);
    await record(claim, result, taskLog);
  }

  async function record(claim: ClaimedTask, result: HandlerResult, taskLog: Logger): Promise<void> {
    const options = { retryPolicy: config.retryPolicy };
    try {
      if (result.kind === 'outcome') {
        await completeTask(db, claim, result.outcome, actor);
        taskLog.info('task completed');
        return;
      }
      if (result.kind === 'error' && result.error instanceof BudgetExhaustedError) {
        await releaseForBudget(db, claim, result.error.exhausted, actor);
        taskLog.warn(
          { exhausted: result.error.exhausted },
          'budget exhausted mid-attempt; run paused for an extension',
        );
        return;
      }
      if (result.kind === 'error') {
        const outcome = await failTaskAttempt(db, claim, toFailure(result.error), actor, options);
        taskLog.warn({ err: result.error, outcome }, 'task attempt failed');
        return;
      }
      switch (result.reason) {
        case 'lease_lost':
          taskLog.warn('lease lost; another worker owns this task now');
          return;
        case 'cancelled':
          await cancelTask(db, claim, actor);
          taskLog.info('run cancelled; task stopped');
          return;
        case 'timeout': {
          const failure = makeFailure(
            'TASK_TIMEOUT',
            `The attempt ran longer than ${String(config.maxAttemptMs)} ms.`,
            true,
          );
          const outcome = await failTaskAttempt(db, claim, failure, actor, options);
          taskLog.warn({ outcome }, 'task attempt timed out');
          return;
        }
        case 'shutdown':
          await releaseTask(db, claim, 'worker shutting down', actor);
          taskLog.info('task handed back for another worker');
          return;
      }
    } catch (error) {
      if (error instanceof LeaseLostError) {
        taskLog.warn('lease lost before the outcome was recorded; result discarded');
        return;
      }
      if (result.kind !== 'outcome') throw error;
      // The handler succeeded but its result could not be applied (invalid expansion, constraint
      // violation): that is a failed attempt, not a success.
      const outcome = await failTaskAttempt(db, claim, toFailure(error), actor, options);
      taskLog.error({ err: error, outcome }, 'task result rejected');
    }
  }

  async function reap(): Promise<void> {
    if (reaping) return;
    reaping = true;
    try {
      const recovered = await recoverExpiredLeases(db, workerId, actor, { retryPolicy: config.retryPolicy });
      if (recovered > 0) log.warn({ recovered }, 'recovered tasks with expired leases');
    } catch (error) {
      log.error({ err: error }, 'lease recovery failed');
    } finally {
      reaping = false;
    }
  }

  return {
    get activeTasks() {
      return active.size;
    },
    start() {
      if (running) return;
      running = true;
      log.info({ workerId, taskTypes, concurrency: config.concurrency }, 'scheduler started');
      void reap();
      reapTimer = setInterval(() => void reap(), config.reapIntervalMs);
      loop = claimLoop();
    },
    async stop() {
      if (!running) return;
      running = false;
      clearInterval(reapTimer);
      wake?.();
      await loop;
      let graceTimer: NodeJS.Timeout | undefined;
      const drained = Promise.allSettled([...active.values()].map((task) => task.done)).then(() => true);
      const graceOver = new Promise<false>((resolve) => {
        graceTimer = setTimeout(() => {
          resolve(false);
        }, config.shutdownGraceMs);
      });
      const drainedInTime = await Promise.race([drained, graceOver]);
      clearTimeout(graceTimer);
      if (!drainedInTime) {
        const remaining = [...active.values()];
        log.warn({ tasks: remaining.length }, 'handlers still running after the grace period; handing tasks back');
        for (const task of remaining) task.controller.abort('shutdown');
        await Promise.allSettled(remaining.map((task) => task.done));
      }
      while (reaping) await new Promise((resolve) => setTimeout(resolve, 10));
      log.info('scheduler stopped');
    },
  };
}
