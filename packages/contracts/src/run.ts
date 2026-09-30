/**
 * Run: one objective moving through the prospect-research workflow.
 * The run row is the anchor for tasks, events, approvals, spend and results.
 */
import { z } from 'zod';
import {
  ApprovalId,
  Count,
  CountryCode,
  ExecutionId,
  Failure,
  FundingStage,
  IsoDate,
  PersonRole,
  ProjectId,
  RunId,
  Timestamp,
  UsdMicros,
  UserId,
  WorkspaceId,
} from './common';

export const WorkflowKey = z.enum(['prospect_research']);
export type WorkflowKey = z.infer<typeof WorkflowKey>;

export const RunStatus = z.enum([
  'draft',
  'planning',
  'awaiting_plan_approval',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatus>;
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

export const PauseReason = z.enum(['awaiting_approval', 'budget_exhausted', 'user_requested']);
export type PauseReason = z.infer<typeof PauseReason>;

/** A default the planner filled in because the objective did not say. Shown on the plan-approval screen. */
export const Assumption = z.object({
  field: z.string().min(1).max(100),
  assumed: z.string().min(1).max(300),
  reason: z.string().min(1).max(500),
});
export type Assumption = z.infer<typeof Assumption>;

/** The machine-readable version of the objective. Code normalises it after the planner proposes it. */
export const InterpretedCriteria = z
  .object({
    sectorKeywords: z.array(z.string().trim().min(2).max(60)).min(1).max(15),
    countries: z.array(CountryCode).min(1).max(60),
    fundingWindow: z.object({ from: IsoDate, to: IsoDate }),
    fundingStages: z.array(FundingStage).max(10),
    maxCompanies: z.int().min(1).max(25),
    peopleRoles: z.array(PersonRole).min(1).max(8),
    outreach: z.object({ enabled: z.boolean(), maxCompanies: z.int().min(0).max(10) }),
  })
  .superRefine((c, ctx) => {
    if (c.fundingWindow.from > c.fundingWindow.to) {
      ctx.addIssue({ code: 'custom', path: ['fundingWindow'], message: 'from must not be after to' });
    }
    if (c.outreach.enabled && c.outreach.maxCompanies === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['outreach', 'maxCompanies'],
        message: 'must be > 0 when outreach is enabled',
      });
    }
    if (c.outreach.maxCompanies > c.maxCompanies) {
      ctx.addIssue({ code: 'custom', path: ['outreach', 'maxCompanies'], message: 'cannot exceed maxCompanies' });
    }
  });
export type InterpretedCriteria = z.infer<typeof InterpretedCriteria>;

export const ResearchBrief = z.object({
  revision: z.int().positive(),
  objective: z.string().min(10).max(4000),
  criteria: InterpretedCriteria,
  assumptions: z.array(Assumption).max(20),
  openQuestions: z.array(z.string().min(1).max(300)).max(10),
  plannerExecutionId: ExecutionId,
});
export type ResearchBrief = z.infer<typeof ResearchBrief>;

export const Budget = z.object({
  maxCostUsdMicros: UsdMicros.max(100_000_000),
  maxLlmTokens: z.int().positive().max(50_000_000),
  maxToolCalls: z.int().positive().max(5_000),
  maxWallClockSeconds: z.int().positive().max(86_400),
});
export type Budget = z.infer<typeof Budget>;

/** Accumulated from llm_calls and tool_calls rows, including failed attempts: real money was spent. */
export const Spend = z.object({
  costUsdMicros: UsdMicros,
  llmInputTokens: Count,
  llmOutputTokens: Count,
  toolCalls: Count,
});
export type Spend = z.infer<typeof Spend>;

export const RunApprovalState = z.object({
  planApprovalId: ApprovalId.nullable(),
  pendingApprovalIds: z.array(ApprovalId),
});

export const Run = z
  .object({
    id: RunId,
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    workflow: WorkflowKey,
    workflowVersion: z.int().positive(),
    objective: z.string().min(10).max(4000),
    brief: ResearchBrief.nullable(),
    status: RunStatus,
    pauseReason: PauseReason.nullable(),
    cancelRequested: z.boolean(),
    /** A user asked to pause: no new tasks are claimed; running tasks finish. */
    pauseRequested: z.boolean(),
    /** The scheduler refused a task for lack of budget; cleared when a budget extension is approved. */
    budgetBlocked: z.boolean(),
    budget: Budget,
    spend: Spend,
    approvals: RunApprovalState,
    failure: Failure.nullable(),
    lastEventSeq: Count,
    createdBy: UserId,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    startedAt: Timestamp.nullable(),
    finishedAt: Timestamp.nullable(),
  })
  .superRefine((run, ctx) => {
    const terminal = TERMINAL_RUN_STATUSES.includes(run.status);
    if ((run.status === 'paused') !== (run.pauseReason !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['pauseReason'],
        message: 'pauseReason is set exactly when status is paused',
      });
    }
    if ((run.status === 'failed') !== (run.failure !== null)) {
      ctx.addIssue({ code: 'custom', path: ['failure'], message: 'failure is set exactly when status is failed' });
    }
    if (terminal !== (run.finishedAt !== null)) {
      ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'finishedAt is set exactly for terminal runs' });
    }
    // A run can be paused while still planning, so paused does not require a brief.
    const needsBrief: readonly RunStatus[] = ['awaiting_plan_approval', 'running', 'completed'];
    if (needsBrief.includes(run.status) && run.brief === null) {
      ctx.addIssue({ code: 'custom', path: ['brief'], message: `a ${run.status} run must have a brief` });
    }
  });
export type Run = z.infer<typeof Run>;
