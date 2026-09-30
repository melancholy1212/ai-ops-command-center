// End-to-end tests of the workflow engine against the local Supabase database, as the backend role
// with row-level security on. Handlers are scripted: this tests orchestration, not agents.
import { randomUUID } from 'node:crypto';
import {
  AgentType,
  ApprovalType,
  ArtifactKind,
  ArtifactStatus,
  ClaimAttribute,
  ClaimStatus,
  ConfidenceLevel,
  FindingKind,
  FindingLabel,
  GroundingResult,
  JudgeVerdict,
  CacheStatus,
  ExecutionStatus,
  ExtractionMethod,
  LlmProviderKind,
  LlmStopReason,
  PublishedAtMethod,
  RouteClass,
  RunEvent,
  RunStatus,
  TASK_DEFINITIONS,
  TaskStatus,
  TaskType,
  ToolErrorCode,
  ToolName,
  SourceTier,
  SourceType,
  UrlOrigin,
  type Actor,
  type ApprovalId,
  type ArtifactId,
  type ClaimId,
  type CompanyId,
  type EvidenceId,
  type ExecutionId,
  type InterpretedCriteria,
  type PersonId,
  type RunId,
  type TaskId,
  type UserId,
} from '@aoc/contracts';
import { withWorkspace } from '@aoc/db';
import { createTestHarness, LOCAL_ADMIN_URL, type TestHarness, type TestTenant } from '@aoc/db/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RUN_BUDGET } from './budget';
import { sha256Hex } from './canonical-json';
import { decideApproval } from './commands/approvals';
import { cancelRun, createRun, pauseRun, resumeRun, startRun } from './commands/runs';
import { assertApprovalCurrent } from './engine/approvals';
import { createTasks } from './engine/graph';
import { claimNextTask, recoverExpiredLeases } from './engine/queue';
import { lockRun } from './engine/runs';
import { recordSpend } from './engine/spend';
import {
  cancelTask,
  completeTask,
  failTaskAttempt,
  heartbeat,
  makeFailure,
  releaseTask,
  startAttempt,
  type StartResult,
} from './engine/transitions';
import type { ApprovalRequest, ClaimedTask, EngineOptions, TaskOutcome } from './engine/types';
import { saveBrief } from './workflow/prospect';
import { DomainError, LeaseLostError } from './errors';

const ALL_TYPES = TaskType.options;
const WORKER: Actor = { kind: 'worker', workerId: 'it-worker' };
const NO_BACKOFF: EngineOptions = { retryPolicy: { baseMs: 0, maxMs: 0, jitterMs: 0 } };
const CRITERIA: InterpretedCriteria = {
  sectorKeywords: ['climate software'],
  countries: ['SE', 'NO', 'DK', 'FI'],
  fundingWindow: { from: '2025-09-30', to: '2026-09-30' },
  fundingStages: ['seed'],
  maxCompanies: 2,
  peopleRoles: ['founder', 'ceo'],
  outreach: { enabled: true, maxCompanies: 1 },
};
const ASSUMPTIONS = [{ field: 'countries', assumed: 'SE, NO, DK, FI', reason: '"Nordics" expanded by region table.' }];
const OBJECTIVE = 'Find seed-stage climate software companies in the Nordics funded in the last 12 months.';

let h: TestHarness;
let owner: TestTenant;
let outsider: TestTenant;
let viewerId: UserId;

beforeAll(async () => {
  h = await createTestHarness();
  owner = await h.createTenant('owner');
  outsider = await h.createTenant('outsider');
  // A second member of the owner's workspace who may only read.
  const viewer = await h.createTenant('viewer');
  viewerId = viewer.userId;
  await h.admin.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'viewer')`, [
    owner.workspaceId,
    viewer.userId,
  ]);
});

afterEach(async () => {
  // The claim query is global, so no test may leave claimable work behind for the next one.
  await h.admin.query('delete from public.runs where workspace_id = any($1)', [
    [owner.workspaceId, outsider.workspaceId],
  ]);
});

afterAll(async () => {
  await h.close();
});

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

const user = (tenant: TestTenant) => ({ userId: tenant.userId });

/** A runs row as the pg driver returns it (bigint columns as strings). */
interface RunSnapshot {
  status: RunStatus;
  pause_reason: string | null;
  failure: { code: string } | null;
  budget: { maxCostUsdMicros: number };
  budget_blocked: boolean;
  started_at: Date | null;
  finished_at: Date | null;
  last_event_seq: string;
  spend_cost_usd_micros: string;
  spend_llm_input_tokens: string;
  spend_tool_calls: number;
}

async function newRun(budget = DEFAULT_RUN_BUDGET): Promise<RunId> {
  return createRun(h.db, user(owner), owner.workspaceId, { projectId: owner.projectId, objective: OBJECTIVE, budget });
}

async function startedRun(budget = DEFAULT_RUN_BUDGET): Promise<RunId> {
  const runId = await newRun(budget);
  await startRun(h.db, user(owner), owner.workspaceId, { runId });
  return runId;
}

async function claim(runId: RunId): Promise<ClaimedTask> {
  const claimed = await claimNextTask(h.db, { workerId: 'it-worker', leaseSeconds: 30, taskTypes: ALL_TYPES });
  expect(claimed, 'expected a claimable task').not.toBeNull();
  expect(claimed?.runId).toBe(runId);
  return claimed!;
}

async function nothingToClaim() {
  expect(await claimNextTask(h.db, { workerId: 'it-worker', leaseSeconds: 30, taskTypes: ALL_TYPES })).toBeNull();
}

async function start(claimed: ClaimedTask): Promise<Extract<StartResult, { started: true }>> {
  const started = await startAttempt(h.db, claimed, WORKER);
  if (!started.started) throw new Error(`attempt not started: ${started.reason}`);
  return started;
}

type Handler = (claimed: ClaimedTask, input: Record<string, unknown>) => TaskOutcome;

/** Claims, starts and completes tasks of one run until nothing is claimable. Returns the types run. */
async function drive(runId: RunId, handlers: Partial<Record<TaskType, Handler>>): Promise<TaskType[]> {
  const done: TaskType[] = [];
  for (;;) {
    const claimed = await claimNextTask(h.db, { workerId: 'it-worker', leaseSeconds: 30, taskTypes: ALL_TYPES });
    if (!claimed) return done;
    expect(claimed.runId).toBe(runId);
    const { task } = await start(claimed);
    const handler = handlers[claimed.taskType] ?? (() => ({ kind: 'succeeded' }) as const);
    await completeTask(h.db, claimed, handler(claimed, task.input as Record<string, unknown>), WORKER);
    done.push(claimed.taskType);
  }
}

async function runRow(runId: RunId): Promise<RunSnapshot> {
  const { rows } = await h.admin.query<RunSnapshot>('select * from public.runs where id = $1', [runId]);
  return rows[0]!;
}

async function taskRows(runId: RunId) {
  const { rows } = await h.admin.query<{
    id: TaskId;
    type: TaskType;
    status: TaskStatus;
    idempotency_key: string;
    attempt: number;
    last_failure: { code: string } | null;
    lease_token: string | null;
  }>('select * from public.tasks where run_id = $1 order by created_at, idempotency_key', [runId]);
  return rows;
}

async function statusByKey(runId: RunId): Promise<Record<string, TaskStatus>> {
  return Object.fromEntries((await taskRows(runId)).map((t) => [t.idempotency_key, t.status]));
}

async function events(runId: RunId) {
  const { rows } = await h.admin.query<{
    run_id: string;
    workspace_id: string;
    seq: string;
    type: string;
    actor: unknown;
    refs: unknown;
    data: unknown;
    occurred_at: Date;
  }>('select * from public.run_events where run_id = $1 order by seq', [runId]);
  return rows;
}

async function pendingApprovals(runId: RunId) {
  const { rows } = await h.admin.query<{ id: ApprovalId; type: ApprovalType; snapshot_hash: string; task_id: TaskId }>(
    `select id, type, snapshot_hash, task_id from public.approvals where run_id = $1 and status = 'pending' order by requested_at`,
    [runId],
  );
  return rows;
}

async function decide(
  approval: { id: ApprovalId; snapshot_hash: string },
  decision: 'approved' | 'rejected',
  reason: string | null = decision === 'rejected' ? 'Too broad.' : null,
  as: UserId = owner.userId,
) {
  return decideApproval(h.db, { userId: as }, owner.workspaceId, {
    approvalId: approval.id,
    decision,
    snapshotHashSeen: approval.snapshot_hash,
    reason,
  });
}

async function expectDomainError(promise: Promise<unknown>, code: DomainError['code']) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
}

function planGate(runId: RunId, revision: number): ApprovalRequest {
  return {
    type: 'plan',
    target: { type: 'plan', runId, briefRevision: revision },
    targetKey: `plan:r${String(revision)}`,
    snapshot: {
      kind: 'plan',
      objective: OBJECTIVE,
      criteria: CRITERIA,
      assumptions: ASSUMPTIONS,
      budget: DEFAULT_RUN_BUDGET,
      estimate: { costUsdMicrosLow: 300_000, costUsdMicrosHigh: 900_000 },
      workflowVersion: 1,
    },
  };
}

function outreachDraft(): ApprovalRequest {
  const artifactId = randomUUID() as ArtifactId;
  return {
    type: 'outreach_draft',
    target: { type: 'outreach_draft', artifactId, artifactVersion: 1 },
    targetKey: `outreach:${artifactId}`,
    snapshot: {
      kind: 'outreach_draft',
      artifactId,
      artifactVersion: 1,
      contentHash: sha256Hex(artifactId),
      channel: 'email',
      subjectLine: 'Your seed round',
      body: 'Congratulations on the seed round announced in March. We help climate software teams hire engineers.',
      citedClaims: [
        {
          claimId: randomUUID() as ClaimId,
          statement: 'Raised a seed round in March 2026.',
          status: 'verified',
          confidence: 'high',
          evidenceIds: [randomUUID() as EvidenceId],
        },
      ],
    },
  };
}

/** The prospect workflow's expansion rules, scripted for two companies. */
function prospectHandlers(companies: CompanyId[]): Partial<Record<TaskType, Handler>> {
  return {
    plan_run: (c, input) => ({
      kind: 'succeeded',
      summary: { revision: input.revision as number },
      write: async (tx) => {
        const brief = {
          revision: input.revision as number,
          objective: OBJECTIVE,
          criteria: CRITERIA,
          assumptions: ASSUMPTIONS,
          openQuestions: [],
          plannerExecutionId: randomUUID() as ExecutionId,
        };
        await saveBrief(tx, { id: c.runId, workspace_id: c.workspaceId }, brief, WORKER);
        return {};
      },
    }),
    approve_plan: (c, input) => ({
      kind: 'awaiting_approval',
      approvals: [planGate(c.runId, input.revision as number)],
    }),
    discover_companies: () => ({
      kind: 'succeeded',
      summary: { candidates: companies.length },
      expand: {
        tasks: [
          ...companies.flatMap((companyId, i) => [
            {
              ref: `profile${String(i)}`,
              type: 'profile_company' as const,
              input: { type: 'profile_company' as const, companyId },
              idempotencyKey: `profile_company:${companyId}`,
            },
            {
              ref: `people${String(i)}`,
              type: 'find_people' as const,
              input: { type: 'find_people' as const, companyId },
              idempotencyKey: `find_people:${companyId}`,
              dependsOn: [{ ref: `profile${String(i)}`, mode: 'hard' as const }],
            },
            {
              ref: `verify${String(i)}`,
              type: 'verify_entity' as const,
              input: { type: 'verify_entity' as const, companyId, round: 1 as const },
              idempotencyKey: `verify_entity:${companyId}:r1`,
              dependsOn: [
                { ref: `profile${String(i)}`, mode: 'hard' as const },
                { ref: `people${String(i)}`, mode: 'soft' as const },
              ],
            },
          ]),
          {
            ref: 'rank',
            type: 'rank_and_analyze',
            input: { type: 'rank_and_analyze' },
            idempotencyKey: 'rank_and_analyze',
            dependsOn: companies.map((_, i) => ({ ref: `verify${String(i)}`, mode: 'soft' as const })),
          },
        ],
      },
    }),
    rank_and_analyze: (c) => ({
      kind: 'succeeded',
      expand: {
        tasks: [
          {
            ref: 'draft',
            type: 'draft_outreach',
            input: {
              type: 'draft_outreach',
              companyId: companies[0]!,
              personIds: [randomUUID() as PersonId],
            },
            idempotencyKey: `draft_outreach:${String(companies[0])}`,
            dependsOn: [{ taskId: c.taskId, mode: 'hard' }],
          },
          {
            ref: 'approve',
            type: 'approve_outreach',
            input: { type: 'approve_outreach' },
            idempotencyKey: 'approve_outreach',
            dependsOn: [{ ref: 'draft', mode: 'soft' }],
          },
          {
            ref: 'report',
            type: 'compile_report',
            input: { type: 'compile_report' },
            idempotencyKey: 'compile_report',
            dependsOn: [
              { ref: 'approve', mode: 'hard' },
              { taskId: c.taskId, mode: 'hard' },
            ],
          },
        ],
      },
    }),
    approve_outreach: () => ({ kind: 'awaiting_approval', approvals: [outreachDraft(), outreachDraft()] }),
  };
}

const twoCompanies = () => [randomUUID() as CompanyId, randomUUID() as CompanyId];

/** Drives a fresh run through planning and plan approval, up to the point where discovery succeeded. */
async function runThroughDiscovery(companies: CompanyId[]): Promise<RunId> {
  const runId = await startedRun();
  const handlers = prospectHandlers(companies);
  expect(await drive(runId, handlers)).toEqual(['plan_run', 'approve_plan']);
  const [plan] = await pendingApprovals(runId);
  await decide(plan!, 'approved');
  const claimed = await claim(runId);
  expect(claimed.taskType).toBe('discover_companies');
  await start(claimed);
  await completeTask(h.db, claimed, handlers.discover_companies!(claimed, {}), WORKER);
  return runId;
}

/** Every event is valid against the contract and sequence numbers have no gaps. */
async function expectConsistentTimeline(runId: RunId) {
  const rows = await events(runId);
  expect(rows.map((r) => Number(r.seq))).toEqual(rows.map((_, i) => i + 1));
  for (const row of rows) {
    const parsed = RunEvent.safeParse({
      runId: row.run_id,
      workspaceId: row.workspace_id,
      seq: Number(row.seq),
      type: row.type,
      actor: row.actor,
      refs: row.refs,
      data: row.data,
      occurredAt: row.occurred_at.toISOString(),
    });
    expect(parsed.success, `${row.type}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
  }
  const run = await runRow(runId);
  expect(Number(run.last_event_seq)).toBe(rows.length);
}

// ---------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------

describe('run lifecycle', () => {
  it('creates a draft run and starts it with the plan task ready', async () => {
    const runId = await newRun();
    expect((await runRow(runId)).status).toBe('draft');
    expect(await taskRows(runId)).toHaveLength(0);

    await startRun(h.db, user(owner), owner.workspaceId, { runId });
    const run = await runRow(runId);
    expect(run.status).toBe('planning');
    expect(run.started_at).not.toBeNull();
    expect(await statusByKey(runId)).toEqual({
      'plan_run:r1': 'ready',
      'approve_plan:r1': 'blocked',
      discover_companies: 'blocked',
    });
    await expectDomainError(startRun(h.db, user(owner), owner.workspaceId, { runId }), 'INVALID_STATE');

    const { rows: audits } = await h.admin.query<{ action: string }>(
      `select action from public.audit_logs where target_id = $1 order by created_at`,
      [runId],
    );
    expect(audits.map((a) => a.action)).toEqual(['run.created', 'run.started']);
    await expectConsistentTimeline(runId);
  });

  it('makes the pages a user names fetchable in the run, with a user_provided origin', async () => {
    const runId = await createRun(h.db, user(owner), owner.workspaceId, {
      projectId: owner.projectId,
      objective: OBJECTIVE,
      seedUrls: [
        'https://News.Example/funding?utm_source=mail#top',
        'https://news.example/funding',
        'https://other.example/a',
      ],
    });
    const { rows } = await h.admin.query<{ normalized_url: string; origin: { kind: string; providedBy: string } }>(
      'select normalized_url, origin from public.discovered_urls where run_id = $1 order by normalized_url',
      [runId],
    );
    expect(rows).toEqual([
      { normalized_url: 'https://news.example/funding', origin: { kind: 'user_provided', providedBy: owner.userId } },
      { normalized_url: 'https://other.example/a', origin: { kind: 'user_provided', providedBy: owner.userId } },
    ]);
  });

  it('runs the whole prospect workflow with both human gates to completion', async () => {
    const companies = twoCompanies();
    const handlers = prospectHandlers(companies);
    const runId = await startedRun();

    expect(await drive(runId, handlers)).toEqual(['plan_run', 'approve_plan']);
    expect((await runRow(runId)).status).toBe('awaiting_plan_approval');
    const [plan] = await pendingApprovals(runId);
    expect(plan?.type).toBe('plan');
    await decide(plan!, 'approved');
    expect((await runRow(runId)).status).toBe('running');

    const worked = await drive(runId, handlers);
    expect(worked[0]).toBe('discover_companies');
    expect(worked.filter((t) => t === 'profile_company')).toHaveLength(2);
    expect(worked.slice(-3)).toEqual(['rank_and_analyze', 'draft_outreach', 'approve_outreach']);
    const paused = await runRow(runId);
    expect([paused.status, paused.pause_reason]).toEqual(['paused', 'awaiting_approval']);

    const drafts = await pendingApprovals(runId);
    expect(drafts.map((d) => d.type)).toEqual(['outreach_draft', 'outreach_draft']);
    await decide(drafts[0]!, 'approved');
    expect((await statusByKey(runId)).approve_outreach).toBe('waiting_approval');
    await decide(drafts[1]!, 'rejected', 'Tone is off.');
    expect((await statusByKey(runId)).approve_outreach).toBe('succeeded');

    expect(await drive(runId, handlers)).toEqual(['compile_report']);
    const done = await runRow(runId);
    expect(done.status).toBe('completed');
    expect(done.finished_at).not.toBeNull();
    const tasks = await taskRows(runId);
    expect(tasks.every((t) => t.status === 'succeeded')).toBe(true);
    expect(tasks.every((t) => t.lease_token === null)).toBe(true);
    await expectConsistentTimeline(runId);

    const statuses = (await events(runId))
      .filter((e) => e.type === 'run.status_changed')
      .map((e) => (e.data as { to: string }).to);
    expect(statuses).toEqual(['planning', 'awaiting_plan_approval', 'running', 'paused', 'running', 'completed']);
  });
});

describe('approvals', () => {
  it('refuses stale, repeated, unauthorised and unreasoned decisions', async () => {
    const runId = await startedRun();
    await drive(runId, prospectHandlers(twoCompanies()));
    const [plan] = await pendingApprovals(runId);

    await expectDomainError(
      decide({ ...plan!, snapshot_hash: sha256Hex('something else') }, 'approved'),
      'STALE_SNAPSHOT',
    );
    await expectDomainError(decide(plan!, 'approved', null, viewerId), 'FORBIDDEN');
    await expectDomainError(decide(plan!, 'approved', null, outsider.userId), 'FORBIDDEN');
    await expectDomainError(decide(plan!, 'rejected', null), 'VALIDATION');
    // Another workspace cannot even see the approval.
    await expectDomainError(
      decideApproval(h.db, user(outsider), outsider.workspaceId, {
        approvalId: plan!.id,
        decision: 'approved',
        snapshotHashSeen: plan!.snapshot_hash,
        reason: null,
      }),
      'NOT_FOUND',
    );

    await decide(plan!, 'approved');
    await expectDomainError(decide(plan!, 'approved'), 'INVALID_STATE');
    const { rows } = await h.admin.query<{ decided_by: string; snapshot_hash_seen: string }>(
      'select decided_by, snapshot_hash_seen from public.approvals where id = $1',
      [plan!.id],
    );
    expect(rows[0]).toEqual({ decided_by: owner.userId, snapshot_hash_seen: plan!.snapshot_hash });
  });

  it('replans with feedback after a rejection and re-points discovery at the new gate', async () => {
    const handlers = prospectHandlers(twoCompanies());
    const runId = await startedRun();
    await drive(runId, handlers);
    const [first] = await pendingApprovals(runId);
    await decide(first!, 'rejected', 'Include Iceland.');

    expect(await statusByKey(runId)).toEqual({
      'plan_run:r1': 'succeeded',
      'approve_plan:r1': 'failed',
      discover_companies: 'blocked',
      'plan_run:r2': 'ready',
      'approve_plan:r2': 'blocked',
    });
    expect((await runRow(runId)).status).toBe('planning');
    const tasks = await taskRows(runId);
    const replan = tasks.find((t) => t.idempotency_key === 'plan_run:r2');
    const { rows: input } = await h.admin.query<{ input: unknown }>('select input from public.tasks where id = $1', [
      replan!.id,
    ]);
    expect(input[0]?.input).toEqual({ type: 'plan_run', revision: 2, rejectionFeedback: 'Include Iceland.' });

    const discover = tasks.find((t) => t.type === 'discover_companies')!;
    const { rows: edges } = await h.admin.query<{ idempotency_key: string }>(
      `select t.idempotency_key from public.task_dependencies d join public.tasks t on t.id = d.depends_on_task_id
       where d.task_id = $1`,
      [discover.id],
    );
    expect(edges.map((e) => e.idempotency_key)).toEqual(['approve_plan:r2']);

    expect(await drive(runId, handlers)).toEqual(['plan_run', 'approve_plan']);
    const [second] = await pendingApprovals(runId);
    await decide(second!, 'approved');
    expect((await statusByKey(runId)).discover_companies).toBe('ready');
    await expectConsistentTimeline(runId);
  });

  it('cancels the run after the maximum number of plan rejections', async () => {
    const handlers = prospectHandlers(twoCompanies());
    const runId = await startedRun();
    for (let revision = 1; revision <= 3; revision += 1) {
      await drive(runId, handlers);
      const [plan] = await pendingApprovals(runId);
      await decide(plan!, 'rejected', `Rejection ${String(revision)}.`);
    }
    const run = await runRow(runId);
    expect(run.status).toBe('cancelled');
    expect((await statusByKey(runId)).discover_companies).toBe('cancelled');
    await nothingToClaim();
    await expectConsistentTimeline(runId);
  });

  it('invalidates an approval whose item changed before use', async () => {
    const runId = await startedRun();
    await drive(runId, prospectHandlers(twoCompanies()));
    const [plan] = await pendingApprovals(runId);
    const original = planGate(runId, 1).snapshot;

    await withWorkspace(h.db, owner.workspaceId, async (tx) => {
      expect(await assertApprovalCurrent(tx, plan!.id, original, 'target_changed', WORKER)).toBe(true);
    });
    const changed = { ...original, objective: `${OBJECTIVE} Also include Iceland.` };
    await withWorkspace(h.db, owner.workspaceId, async (tx) => {
      expect(await assertApprovalCurrent(tx, plan!.id, changed, 'target_changed', WORKER)).toBe(false);
    });
    const { rows } = await h.admin.query<{ status: string; invalidation_reason: string }>(
      'select status, invalidation_reason from public.approvals where id = $1',
      [plan!.id],
    );
    expect(rows[0]).toEqual({ status: 'invalidated', invalidation_reason: 'target_changed' });
    await expectDomainError(decide(plan!, 'approved'), 'INVALID_STATE');
    expect((await events(runId)).at(-1)?.type).toBe('approval.invalidated');
  });
});

describe('failures and dependencies', () => {
  it('retries transient failures and fails the run when a fatal task runs out of attempts', async () => {
    const runId = await startedRun();
    const outcomes: string[] = [];
    for (let i = 0; i < TASK_DEFINITIONS.plan_run.maxAttempts; i += 1) {
      const claimed = await claim(runId);
      expect(claimed.attempt).toBe(i + 1);
      await start(claimed);
      outcomes.push(
        await failTaskAttempt(
          h.db,
          claimed,
          makeFailure('PROVIDER_UNAVAILABLE', 'upstream 503', true),
          WORKER,
          NO_BACKOFF,
        ),
      );
    }
    expect(outcomes).toEqual(['retry_scheduled', 'retry_scheduled', 'failed']);
    const run = await runRow(runId);
    expect(run.status).toBe('failed');
    expect(run.failure?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(await statusByKey(runId)).toEqual({
      'plan_run:r1': 'failed',
      'approve_plan:r1': 'skipped',
      discover_companies: 'skipped',
    });
    expect((await events(runId)).filter((e) => e.type === 'task.retry_scheduled')).toHaveLength(2);
    await expectConsistentTimeline(runId);
  });

  it('fails permanent errors without retrying', async () => {
    const runId = await startedRun();
    const claimed = await claim(runId);
    await start(claimed);
    const outcome = await failTaskAttempt(
      h.db,
      claimed,
      makeFailure('LLM_OUTPUT_INVALID', 'schema mismatch after repair', false),
      WORKER,
      NO_BACKOFF,
    );
    expect(outcome).toBe('failed');
    expect((await runRow(runId)).status).toBe('failed');
  });

  it('skips a failed company chain through hard edges while soft edges let the run continue', async () => {
    const companies = twoCompanies();
    const runId = await runThroughDiscovery(companies);
    const [a, b] = companies.map(String);

    // profile A fails permanently: people A and verify A are skipped (hard edges).
    let claimed = await claim(runId);
    expect(claimed.taskType).toBe('profile_company');
    const profileTask = (await taskRows(runId)).find((t) => t.id === claimed.taskId)!;
    const failing = profileTask.idempotency_key === `profile_company:${a!}` ? a! : b!;
    const healthy = failing === a ? b! : a!;
    await start(claimed);
    await failTaskAttempt(h.db, claimed, makeFailure('TOOL_FAILED', 'registry offline', false), WORKER, NO_BACKOFF);
    let statuses = await statusByKey(runId);
    expect(statuses[`find_people:${failing}`]).toBe('skipped');
    expect(statuses[`verify_entity:${failing}:r1`]).toBe('skipped');
    expect((await runRow(runId)).status).toBe('running');

    // profile B succeeds, find_people B fails: verify B still runs (soft edge).
    claimed = await claim(runId);
    expect(claimed.taskType).toBe('profile_company');
    await start(claimed);
    await completeTask(h.db, claimed, { kind: 'succeeded' }, WORKER);
    claimed = await claim(runId);
    expect(claimed.taskType).toBe('find_people');
    await start(claimed);
    await failTaskAttempt(h.db, claimed, makeFailure('AGENT_LIMIT_REACHED', 'turn cap', false), WORKER, NO_BACKOFF);
    statuses = await statusByKey(runId);
    expect(statuses[`verify_entity:${healthy}:r1`]).toBe('ready');
    expect(statuses.rank_and_analyze).toBe('blocked');

    claimed = await claim(runId);
    expect(claimed.taskType).toBe('verify_entity');
    await start(claimed);
    await completeTask(h.db, claimed, { kind: 'succeeded' }, WORKER);
    // rank's soft dependencies are all terminal now (one skipped, one succeeded).
    expect((await statusByKey(runId)).rank_and_analyze).toBe('ready');
    await expectConsistentTimeline(runId);
  });

  it('promotes a shared dependent exactly once when siblings finish concurrently', async () => {
    const runId = await runThroughDiscovery(twoCompanies());
    const first = await claim(runId);
    const second = await claim(runId);
    expect([first.taskType, second.taskType]).toEqual(['profile_company', 'profile_company']);
    await Promise.all([start(first), start(second)]);
    await Promise.all([
      completeTask(h.db, first, { kind: 'succeeded' }, WORKER),
      completeTask(h.db, second, { kind: 'succeeded' }, WORKER),
    ]);
    const statuses = Object.entries(await statusByKey(runId));
    expect(statuses.filter(([key, s]) => key.startsWith('find_people') && s === 'ready')).toHaveLength(2);
    const promotions = (await events(runId)).filter(
      (e) => e.type === 'task.status_changed' && (e.data as { to: string; from: string }).from === 'blocked',
    );
    const promotedIds = promotions.map((e) => (e.refs as { taskId: string }).taskId);
    expect(new Set(promotedIds).size).toBe(promotedIds.length);
    await expectConsistentTimeline(runId);
  });
});

describe('graph changes', () => {
  it('applies the same expansion twice without duplicating tasks or edges', async () => {
    const companies = twoCompanies();
    const runId = await runThroughDiscovery(companies);
    const before = await taskRows(runId);
    const { rows: edgesBefore } = await h.admin.query<{ n: number }>(
      'select count(*)::int as n from public.task_dependencies where run_id = $1',
      [runId],
    );
    const plan = prospectHandlers(companies).discover_companies!({} as ClaimedTask, {});
    if (plan.kind !== 'succeeded' || !plan.expand) throw new Error('expected an expansion');
    const expansion = typeof plan.expand === 'function' ? plan.expand({}) : plan.expand;
    const created = await withWorkspace(h.db, owner.workspaceId, async (tx) =>
      createTasks(tx, await lockRun(tx, runId), expansion, null, 'expansion', WORKER),
    );
    expect(created).toEqual([]);
    expect(await taskRows(runId)).toHaveLength(before.length);
    const { rows: edgesAfter } = await h.admin.query<{ n: number }>(
      'select count(*)::int as n from public.task_dependencies where run_id = $1',
      [runId],
    );
    expect(edgesAfter[0]?.n).toBe(edgesBefore[0]?.n);
  });

  it('rejects cycles and new dependencies on tasks that are no longer blocked', async () => {
    const runId = await startedRun();
    const tasks = await taskRows(runId);
    const id = (key: string) => tasks.find((t) => t.idempotency_key === key)!.id;

    await expect(
      withWorkspace(h.db, owner.workspaceId, async (tx) =>
        createTasks(
          tx,
          await lockRun(tx, runId),
          {
            tasks: [],
            addDependencies: [
              { taskId: id('approve_plan:r1'), dependsOn: [{ taskId: id('discover_companies'), mode: 'hard' }] },
            ],
          },
          null,
          'expansion',
          WORKER,
        ),
      ),
    ).rejects.toThrow(/cycle/);
    await expect(
      withWorkspace(h.db, owner.workspaceId, async (tx) =>
        createTasks(
          tx,
          await lockRun(tx, runId),
          {
            tasks: [],
            addDependencies: [
              { taskId: id('plan_run:r1'), dependsOn: [{ taskId: id('discover_companies'), mode: 'soft' }] },
            ],
          },
          null,
          'expansion',
          WORKER,
        ),
      ),
    ).rejects.toThrow(/only blocked tasks/);
    const { rows } = await h.admin.query<{ n: number }>(
      'select count(*)::int as n from public.task_dependencies where run_id = $1',
      [runId],
    );
    expect(rows[0]?.n).toBe(2);
  });
});

describe('leases', () => {
  it('recovers an expired lease, fences the old worker out and retries the task', async () => {
    const runId = await startedRun();
    const zombie = await claim(runId);
    await start(zombie);
    await h.admin.query(`update public.tasks set lease_expires_at = now() - interval '1 second' where id = $1`, [
      zombie.taskId,
    ]);

    // Asserted by state, not by count: a local `pnpm dev` worker may recover the lease first.
    await recoverExpiredLeases(h.db, 'it-reaper', WORKER, NO_BACKOFF);
    const [task] = (await taskRows(runId)).filter((t) => t.id === zombie.taskId);
    expect([task?.status, task?.last_failure?.code, task?.lease_token]).toEqual(['ready', 'LEASE_EXPIRED', null]);
    const expired = (await events(runId)).find((e) => e.type === 'task.lease_expired');
    expect((expired?.data as { workerId: string }).workerId).toBe('it-worker');

    // The old worker wakes up: its heartbeat and its result are both refused.
    expect(await heartbeat(h.db, zombie, 30)).toBe('lost');
    let wrote = false;
    await expect(
      completeTask(
        h.db,
        zombie,
        {
          kind: 'succeeded',
          write: () => {
            wrote = true;
            return Promise.resolve({});
          },
        },
        WORKER,
      ),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(wrote).toBe(false);

    const retry = await claim(runId);
    expect([retry.taskId, retry.attempt]).toEqual([zombie.taskId, 2]);
    await expect(
      completeTask(h.db, { ...retry, leaseToken: randomUUID() }, { kind: 'succeeded' }, WORKER),
    ).rejects.toBeInstanceOf(LeaseLostError);
    const { task: retried } = await start(retry);
    const plan = prospectHandlers(twoCompanies()).plan_run!(retry, retried.input as Record<string, unknown>);
    await completeTask(h.db, retry, plan, WORKER);
    expect((await statusByKey(runId))['plan_run:r1']).toBe('succeeded');
    await expectConsistentTimeline(runId);
  });
});

describe('claiming', () => {
  it('claims from a run even while a transition holds the run row', async () => {
    const runId = await startedRun();
    // A second connection plays a transition in progress: it holds the run row lock.
    const blocker = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL ?? LOCAL_ADMIN_URL });
    await blocker.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select id from public.runs where id = $1 for update', [runId]);
      const claimed = await claimNextTask(h.db, { workerId: 'it-worker', leaseSeconds: 30, taskTypes: ALL_TYPES });
      expect(claimed?.runId).toBe(runId);
    } finally {
      await blocker.query('rollback');
      await blocker.end();
    }
  });
});

describe('executions', () => {
  async function openExecution(claimed: ClaimedTask) {
    const { rows } = await h.admin.query<{ id: string }>(
      `insert into public.agent_executions (workspace_id, run_id, task_id, agent, agent_version, prompt_hash, attempt,
         lease_token, input, limits)
       values ($1, $2, $3, 'planner', 'planner@1', $4, $5, $6, '{}', '{}') returning id`,
      [owner.workspaceId, claimed.runId, claimed.taskId, sha256Hex('prompt'), claimed.attempt, claimed.leaseToken],
    );
    return rows[0]!.id;
  }
  async function execution(id: string) {
    const { rows } = await h.admin.query<{ status: string; failure: { code: string } | null }>(
      'select status, failure from public.agent_executions where id = $1',
      [id],
    );
    return [rows[0]?.status, rows[0]?.failure?.code];
  }

  it('closes an execution its runtime never finished, with the reason the attempt ended', async () => {
    const runId = await startedRun();
    const first = await claim(runId);
    await start(first);
    const reaped = await openExecution(first);
    await h.admin.query(`update public.tasks set lease_expires_at = now() - interval '1 second' where id = $1`, [
      first.taskId,
    ]);
    await recoverExpiredLeases(h.db, 'it-reaper', WORKER, NO_BACKOFF);
    expect(await execution(reaped)).toEqual(['abandoned', 'LEASE_EXPIRED']);

    const second = await claim(runId);
    await start(second);
    const released = await openExecution(second);
    await releaseTask(h.db, second, 'worker shutting down', WORKER);
    expect(await execution(released)).toEqual(['abandoned', 'WORKER_SHUTDOWN']);

    const third = await claim(runId);
    await start(third);
    const cancelled = await openExecution(third);
    await cancelRun(h.db, user(owner), owner.workspaceId, { runId, reason: null });
    await cancelTask(h.db, third, WORKER);
    expect(await execution(cancelled)).toEqual(['abandoned', 'CANCELLED']);
  });
});

describe('cancel and pause', () => {
  it('cancels waiting work at once and discards the result of a task that was running', async () => {
    const runId = await startedRun();
    const running = await claim(runId);
    await start(running);
    await cancelRun(h.db, user(owner), owner.workspaceId, { runId, reason: 'Wrong objective.' });

    expect((await runRow(runId)).status).toBe('cancelled');
    expect(await statusByKey(runId)).toEqual({
      'plan_run:r1': 'running',
      'approve_plan:r1': 'cancelled',
      discover_companies: 'cancelled',
    });
    expect(await heartbeat(h.db, running, 30)).toBe('cancelled');
    let wrote = false;
    await completeTask(
      h.db,
      running,
      {
        kind: 'succeeded',
        write: () => {
          wrote = true;
          return Promise.resolve({});
        },
      },
      WORKER,
    );
    expect(wrote).toBe(false);
    expect((await statusByKey(runId))['plan_run:r1']).toBe('cancelled');
    await expectDomainError(cancelRun(h.db, user(owner), owner.workspaceId, { runId, reason: null }), 'INVALID_STATE');
    await expectConsistentTimeline(runId);
  });

  it('invalidates pending approvals when the run is cancelled', async () => {
    const runId = await startedRun();
    await drive(runId, prospectHandlers(twoCompanies()));
    const [plan] = await pendingApprovals(runId);
    await cancelRun(h.db, user(owner), owner.workspaceId, { runId, reason: null });
    const { rows } = await h.admin.query<{ status: string; invalidation_reason: string }>(
      'select status, invalidation_reason from public.approvals where id = $1',
      [plan!.id],
    );
    expect(rows[0]).toEqual({ status: 'invalidated', invalidation_reason: 'run_cancelled' });
    expect((await statusByKey(runId))['approve_plan:r1']).toBe('cancelled');
  });

  it('pauses and resumes: nothing is claimed while paused', async () => {
    const runId = await startedRun();
    await expectDomainError(pauseRun(h.db, { userId: viewerId }, owner.workspaceId, { runId }), 'FORBIDDEN');
    await pauseRun(h.db, user(owner), owner.workspaceId, { runId });
    const paused = await runRow(runId);
    expect([paused.status, paused.pause_reason]).toEqual(['paused', 'user_requested']);
    await nothingToClaim();

    await resumeRun(h.db, user(owner), owner.workspaceId, { runId });
    expect((await runRow(runId)).status).toBe('planning');
    expect((await claim(runId)).taskType).toBe('plan_run');
    await expectConsistentTimeline(runId);
  });
});

describe('budget', () => {
  it('pauses before work that would not fit and continues after an approved extension', async () => {
    // plan_run is estimated at 20 000 micro-USD; the first extension (x1.5) is enough.
    const runId = await startedRun({ ...DEFAULT_RUN_BUDGET, maxCostUsdMicros: 15_000 });
    const refused = await startAttempt(h.db, await claim(runId), WORKER);
    expect(refused).toEqual({ started: false, reason: 'budget' });
    const run = await runRow(runId);
    expect([run.status, run.pause_reason, run.budget_blocked]).toEqual(['paused', 'budget_exhausted', true]);
    expect((await taskRows(runId))[0]?.attempt).toBe(0);
    await nothingToClaim();

    const [extension] = await pendingApprovals(runId);
    expect(extension?.type).toBe('budget_extension');
    await decide(extension!, 'approved');
    const extended = await runRow(runId);
    expect([extended.status, extended.budget_blocked, extended.budget.maxCostUsdMicros]).toEqual([
      'planning',
      false,
      22_500,
    ]);
    const retried = await claim(runId);
    expect(retried.attempt).toBe(1);
    await start(retried);
    await expectConsistentTimeline(runId);
  });

  it('stays paused after a rejected extension until the user resumes, which asks again', async () => {
    const runId = await startedRun({ ...DEFAULT_RUN_BUDGET, maxCostUsdMicros: 15_000 });
    await startAttempt(h.db, await claim(runId), WORKER);
    const [extension] = await pendingApprovals(runId);
    await decide(extension!, 'rejected', 'Not worth more.');
    expect((await runRow(runId)).pause_reason).toBe('budget_exhausted');
    await nothingToClaim();

    await resumeRun(h.db, user(owner), owner.workspaceId, { runId });
    expect(await startAttempt(h.db, await claim(runId), WORKER)).toEqual({ started: false, reason: 'budget' });
    expect(await pendingApprovals(runId)).toHaveLength(1);
  });

  it('records spend and emits each threshold once', async () => {
    const runId = await startedRun({ ...DEFAULT_RUN_BUDGET, maxCostUsdMicros: 1_000_000 });
    await recordSpend(h.db, owner.workspaceId, runId, { costUsdMicros: 600_000, llmInputTokens: 10 }, WORKER);
    await recordSpend(h.db, owner.workspaceId, runId, { costUsdMicros: 500_000, toolCalls: 3 }, WORKER);
    const run = await runRow(runId);
    expect([run.spend_cost_usd_micros, run.spend_llm_input_tokens, run.spend_tool_calls]).toEqual(['1100000', '10', 3]);
    const crossed = (await events(runId))
      .filter((e) => e.type === 'budget.threshold_crossed')
      .map((e) => (e.data as { percent: number }).percent);
    expect(crossed).toEqual([50, 80, 100]);
  });
});

describe('isolation and schema drift', () => {
  it('keeps runs invisible and untouchable across workspaces', async () => {
    const runId = await startedRun();
    await expectDomainError(startRun(h.db, user(outsider), outsider.workspaceId, { runId }), 'NOT_FOUND');
    await expectDomainError(
      cancelRun(h.db, user(outsider), outsider.workspaceId, { runId, reason: null }),
      'NOT_FOUND',
    );
    // Claiming the right workspace id is not enough: the membership check comes first.
    await expectDomainError(cancelRun(h.db, user(outsider), owner.workspaceId, { runId, reason: null }), 'FORBIDDEN');
    const visible = await withWorkspace(h.db, outsider.workspaceId, (tx) =>
      tx.selectFrom('runs').select('id').where('id', '=', runId).execute(),
    );
    expect(visible).toEqual([]);
  });

  it('keeps contract enums and database CHECK constraints identical', async () => {
    const allowed = async (table: string, column: string) => {
      const { rows } = await h.admin.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid = $1::regclass and contype = 'c'`,
        [`public.${table}`],
      );
      // The enum CHECK is exactly `CHECK ((column = ANY (ARRAY[...])))`, not a rule that merely mentions the column.
      const def = rows
        .map((r) => r.def)
        .find((d) => d.startsWith(`CHECK ((${column} = ANY (ARRAY[`) && d.endsWith('])))'));
      expect(def, `${table}.${column} has an enum CHECK`).toBeDefined();
      return [...(def ?? '').matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort();
    };
    const sorted = (values: readonly string[]) => [...values].sort();
    expect(await allowed('runs', 'status')).toEqual(sorted(RunStatus.options));
    expect(await allowed('tasks', 'status')).toEqual(sorted(TaskStatus.options));
    expect(await allowed('tasks', 'type')).toEqual(sorted(TaskType.options));
    expect(await allowed('approvals', 'type')).toEqual(sorted(ApprovalType.options));
    expect(await allowed('run_events', 'type')).toEqual(sorted(RunEvent.options.map((o) => o.shape.type.value)));
    expect(await allowed('agent_executions', 'agent')).toEqual(sorted(AgentType.options));
    expect(await allowed('agent_executions', 'status')).toEqual(sorted(ExecutionStatus.options));
    expect(await allowed('llm_calls', 'provider')).toEqual(sorted(LlmProviderKind.options));
    expect(await allowed('llm_calls', 'route')).toEqual(sorted(RouteClass.options));
    expect(await allowed('llm_calls', 'cache_status')).toEqual(sorted(CacheStatus.options));
    expect(await allowed('llm_calls', 'stop_reason')).toEqual(sorted(LlmStopReason.options));
    expect(await allowed('tool_calls', 'tool')).toEqual(sorted(ToolName.options));
    expect(await allowed('tool_calls', 'error_code')).toEqual(sorted(ToolErrorCode.options));
    expect(await allowed('discovered_urls', 'origin_kind')).toEqual(
      sorted(UrlOrigin.options.map((o) => o.shape.kind.value)),
    );
    expect(await allowed('sources', 'source_type')).toEqual(sorted(SourceType.options));
    expect(await allowed('sources', 'tier')).toEqual(sorted(SourceTier.options));
    expect(await allowed('sources', 'published_at_method')).toEqual(sorted(PublishedAtMethod.options));
    expect(await allowed('sources', 'extraction_method')).toEqual(sorted(ExtractionMethod.options));
    expect(await allowed('claims', 'attribute')).toEqual(sorted(ClaimAttribute.options));
    expect(await allowed('claims', 'status')).toEqual(sorted(ClaimStatus.options));
    expect(await allowed('claims', 'confidence')).toEqual(sorted(ConfidenceLevel.options));
    expect(await allowed('evidence', 'grounding')).toEqual(sorted(GroundingResult.options));
    expect(await allowed('evidence', 'judge_verdict')).toEqual(sorted(JudgeVerdict.options));
    expect(await allowed('findings', 'kind')).toEqual(sorted(FindingKind.options));
    expect(await allowed('findings', 'label')).toEqual(sorted(FindingLabel.options));
    expect(await allowed('artifacts', 'kind')).toEqual(sorted(ArtifactKind.options));
    expect(await allowed('artifacts', 'status')).toEqual(sorted(ArtifactStatus.options));
  });
});
