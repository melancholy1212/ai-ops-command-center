/**
 * Task handlers by type. The scheduler claims only the types listed here. Phase 3 registers discovery (the
 * Research agent); the planner, verification and the other agents follow in Phases 4 and 5.
 */
import { createHash } from 'node:crypto';
import { Budget, ResearchBrief, type ClaimId, type ExecutionId, type SourceId } from '@aoc/contracts';
import {
  applyVerification,
  normalizePlan,
  planSnapshot,
  saveBrief,
  BudgetExhaustedError,
  discoveryExpansion,
  judgeItems,
  loadCompanyForVerification,
  type JudgeVerdictRecord,
  evaluateBudget,
  persistDiscovery,
  TaskFailure,
  toFailure,
  type ClaimedTask,
  type DiscoveryResult,
} from '@aoc/core';
import { withWorkspace, type Database } from '@aoc/db';
import type { LlmRouter } from '@aoc/llm';
import { promptHash, runToolLoop, type AgentRole } from './agents/loop';
import { ExecutionRecorder } from './agents/recorder';
import type { TokenMinter } from './agents/tokens';
import type { ToolClient } from './agents/tool-client';
import { discoveryRole, type DiscoveryOutput } from './roles/research';
import { VERIFIER_BATCH_SIZE, verifierRole } from './roles/verifier';
import { plannerRole } from './roles/planner';
import { runStructuredCall, type StructuredRole } from './agents/structured';
import type { HandlerRegistry } from './scheduler';

export interface AgentDependencies {
  router: LlmRouter;
  mintToken: TokenMinter;
  /** Opens an MCP session for one execution with its capability token. */
  connectTools: (token: string) => Promise<ToolClient>;
  now?: () => Date;
}

async function readRun(db: Database, claim: ClaimedTask) {
  return withWorkspace(db, claim.workspaceId, (tx) =>
    tx
      .selectFrom('runs')
      .select([
        'objective',
        'brief',
        'budget',
        'started_at',
        'spend_cost_usd_micros',
        'spend_llm_input_tokens',
        'spend_llm_output_tokens',
        'spend_tool_calls',
        'workflow_version',
      ])
      .where('id', '=', claim.runId)
      .executeTakeFirstOrThrow(),
  );
}

const AGENT_ACTOR = { kind: 'worker', workerId: 'agent-runtime' } as const;

/** Prompt identity for a structured role: its version and system prompt. */
function structuredPromptHash(role: StructuredRole<unknown, unknown>): string {
  return createHash('sha256').update(`${role.version}\n${role.system}`).digest('hex');
}

/** URLs the user named for the run (user_provided origins), in the order they were given. */
async function seedUrls(db: Database, claim: ClaimedTask): Promise<string[]> {
  const rows = await withWorkspace(db, claim.workspaceId, (tx) =>
    tx
      .selectFrom('discovered_urls')
      .select('normalized_url')
      .where('run_id', '=', claim.runId)
      .where('origin_kind', '=', 'user_provided')
      .orderBy('discovered_at')
      .limit(20)
      .execute(),
  );
  return rows.map((r) => r.normalized_url);
}

/**
 * Exhausted budget dimensions right now (nothing left for another call), checked before every model call.
 * Elapsed time is real time, never the (possibly frozen) clock the agent sees.
 */
function budgetChecker(db: Database, claim: ClaimedTask) {
  return async () => {
    const run = await readRun(db, claim);
    const { exhausted } = evaluateBudget(
      {
        budget: Budget.parse(run.budget),
        spend: {
          costUsdMicros: Number(run.spend_cost_usd_micros),
          llmInputTokens: Number(run.spend_llm_input_tokens),
          llmOutputTokens: Number(run.spend_llm_output_tokens),
          toolCalls: run.spend_tool_calls,
        },
        startedAt: run.started_at,
      },
      { costUsdMicros: 0, llmTokens: 0, toolCalls: 0 },
      new Date(),
    );
    return exhausted;
  };
}

/** Runs one agent role for one task attempt: execution row, capability token, MCP session, loop, outcome. */
async function runAgent<I, O>(
  deps: AgentDependencies,
  db: Database,
  claim: ClaimedTask,
  role: AgentRole<I, O>,
  input: I,
  signal: AbortSignal,
) {
  const recorder = await ExecutionRecorder.start(db, claim, {
    agent: role.agent,
    agentVersion: role.version,
    promptHash: promptHash(role),
    input,
    limits: role.limits,
  });
  let tools: ToolClient | null = null;
  try {
    const token = await deps.mintToken({
      workspaceId: claim.workspaceId,
      runId: claim.runId,
      taskId: claim.taskId,
      executionId: recorder.executionId as Parameters<TokenMinter>[0]['executionId'],
      agent: role.agent,
      tools: role.tools,
      maxToolCalls: role.limits.maxToolCalls,
      ttlSeconds: Math.ceil(role.limits.timeoutMs / 1000) + 120,
    });
    tools = await deps.connectTools(token);
    const output = await runToolLoop({
      role,
      input,
      router: deps.router,
      tools,
      recorder,
      checkBudget: budgetChecker(db, claim),
      signal,
    });
    return { output, recorder };
  } catch (error) {
    // Budget pauses and stops (lease lost, cancel, shutdown) are closed by the engine; real failures here.
    if (!(error instanceof BudgetExhaustedError) && !signal.aborted) await recorder.fail(toFailure(error));
    throw error;
  } finally {
    await tools?.close().catch(() => undefined);
  }
}

export function createHandlers(deps: AgentDependencies): HandlerRegistry {
  const today = () => (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  return {
    async discover_companies({ claim, db, signal }) {
      const run = await readRun(db, claim);
      const brief = ResearchBrief.safeParse(run.brief);
      if (!brief.success) throw new TaskFailure('DEPENDENCY_FAILED', 'Discovery needs an approved research brief.');
      const { output, recorder } = await runAgent(
        deps,
        db,
        claim,
        discoveryRole,
        {
          objective: run.objective,
          criteria: brief.data.criteria,
          today: today(),
          seedUrls: await seedUrls(db, claim),
        },
        signal,
      );
      const companies = new Set(
        output.claims.map((c: DiscoveryOutput['claims'][number]) =>
          c.subject.kind === 'new_company' ? c.subject.name.toLowerCase() : '',
        ),
      );
      const criteria = brief.data.criteria;
      let discovered: DiscoveryResult | null = null;
      return {
        kind: 'succeeded',
        summary: { claimsProposed: output.claims.length, companies: companies.size },
        // Code grounds and saves the proposals in the completion transaction, then expands the graph from them.
        write: async (tx) => {
          await recorder.succeedInTx(tx, output);
          discovered = await persistDiscovery(
            tx,
            {
              run: { id: claim.runId, workspace_id: claim.workspaceId },
              taskId: claim.taskId,
              executionId: recorder.executionId,
              agent: 'research',
              criteria,
              now: (deps.now ?? (() => new Date()))(),
            },
            output.claims,
          );
          return {
            companyIds: discovered.companies.map((c) => c.id),
            claimIds: discovered.claimIds as ClaimId[],
            sourceIds: discovered.sourceIds as SourceId[],
          };
        },
        expand: () => discoveryExpansion(discovered?.companies ?? [], criteria.maxCompanies),
      };
    },

    async verify_entity({ claim, input, db, signal }) {
      if (input.type !== 'verify_entity')
        throw new TaskFailure('INTERNAL_ERROR', 'verify_entity received the wrong input.');
      const run = await readRun(db, claim);
      const brief = ResearchBrief.safeParse(run.brief);
      if (!brief.success) throw new TaskFailure('DEPENDENCY_FAILED', 'Verification needs the research brief.');
      const company = await withWorkspace(db, claim.workspaceId, (tx) =>
        loadCompanyForVerification(tx, claim.runId, input.companyId),
      );
      const items = judgeItems(company);
      const verdicts: JudgeVerdictRecord[] = [];
      let recorder: ExecutionRecorder | null = null;
      if (items.length > 0) {
        recorder = await ExecutionRecorder.start(db, claim, {
          agent: verifierRole.agent,
          agentVersion: verifierRole.version,
          promptHash: structuredPromptHash(verifierRole),
          input: { companyId: input.companyId, quotes: items.length },
          limits: {
            maxTurns: 3 * Math.ceil(items.length / VERIFIER_BATCH_SIZE),
            maxToolCalls: 0,
            maxOutputTokensPerCall: verifierRole.maxOutputTokens,
            timeoutMs: 600_000,
          },
        });
        try {
          for (let start = 0; start < items.length; start += VERIFIER_BATCH_SIZE) {
            const batch = items.slice(start, start + VERIFIER_BATCH_SIZE);
            const { output, callId } = await runStructuredCall({
              role: verifierRole,
              input: {
                items: batch.map((item, index) => ({
                  index,
                  claim: item.statement,
                  quote: item.quote,
                  context: item.context,
                })),
              },
              router: deps.router,
              recorder,
              checkBudget: budgetChecker(db, claim),
              signal,
            });
            for (const v of output.verdicts) {
              const item = batch[v.index];
              if (item)
                verdicts.push({ evidenceId: item.evidenceId, verdict: v.verdict, reason: v.reason, llmCallId: callId });
            }
          }
        } catch (error) {
          if (!(error instanceof BudgetExhaustedError) && !signal.aborted) await recorder.fail(toFailure(error));
          throw error;
        }
      }
      const criteria = brief.data.criteria;
      const done = recorder;
      return {
        kind: 'succeeded',
        summary: { claims: company.claims.length, quotesJudged: verdicts.length },
        write: async (tx) => {
          if (done) await done.succeedInTx(tx, { verdicts: verdicts.length });
          await applyVerification(
            tx,
            {
              run: { id: claim.runId, workspace_id: claim.workspaceId },
              taskId: claim.taskId,
              criteria,
              now: (deps.now ?? (() => new Date()))(),
            },
            company,
            verdicts,
          );
          return { claimIds: company.claims.map((c) => c.id) as ClaimId[] };
        },
      };
    },

    async plan_run({ claim, input, db, signal }) {
      if (input.type !== 'plan_run') throw new TaskFailure('INTERNAL_ERROR', 'plan_run received the wrong input.');
      const run = await readRun(db, claim);
      const previous = ResearchBrief.safeParse(run.brief);
      const recorder = await ExecutionRecorder.start(db, claim, {
        agent: plannerRole.agent,
        agentVersion: plannerRole.version,
        promptHash: structuredPromptHash(plannerRole),
        input: { revision: input.revision, rejectionFeedback: input.rejectionFeedback },
        limits: {
          maxTurns: 3,
          maxToolCalls: 0,
          maxOutputTokensPerCall: plannerRole.maxOutputTokens,
          timeoutMs: 300_000,
        },
      });
      let proposal;
      try {
        ({ output: proposal } = await runStructuredCall({
          role: plannerRole,
          input: {
            objective: run.objective,
            today: today(),
            revision: input.revision,
            rejectionFeedback: input.rejectionFeedback,
            previousCriteria: previous.success ? previous.data.criteria : null,
          },
          router: deps.router,
          recorder,
          checkBudget: budgetChecker(db, claim),
          signal,
        }));
      } catch (error) {
        if (!(error instanceof BudgetExhaustedError) && !signal.aborted) await recorder.fail(toFailure(error));
        throw error;
      }
      const plan = normalizePlan(proposal, today());
      const brief = {
        revision: input.revision,
        objective: run.objective,
        criteria: plan.criteria,
        assumptions: plan.assumptions,
        openQuestions: plan.openQuestions,
        plannerExecutionId: recorder.executionId as ExecutionId,
      };
      return {
        kind: 'succeeded',
        summary: {
          revision: input.revision,
          countries: plan.criteria.countries.length,
          assumptions: plan.assumptions.length,
        },
        write: async (tx) => {
          await recorder.succeedInTx(tx, brief);
          await saveBrief(tx, { id: claim.runId, workspace_id: claim.workspaceId }, brief, AGENT_ACTOR);
          return {};
        },
      };
    },

    async approve_plan({ claim, input, db }) {
      if (input.type !== 'approve_plan')
        throw new TaskFailure('INTERNAL_ERROR', 'approve_plan received the wrong input.');
      const run = await readRun(db, claim);
      const brief = ResearchBrief.parse(run.brief);
      if (brief.revision !== input.revision) {
        throw new TaskFailure(
          'INTERNAL_ERROR',
          `The brief is revision ${String(brief.revision)}, the gate is for ${String(input.revision)}.`,
        );
      }
      return {
        kind: 'awaiting_approval',
        approvals: [
          {
            type: 'plan',
            target: { type: 'plan', runId: claim.runId, briefRevision: brief.revision },
            targetKey: `plan:r${String(brief.revision)}`,
            snapshot: planSnapshot(brief, Budget.parse(run.budget), run.workflow_version),
          },
        ],
      };
    },
  };
}
