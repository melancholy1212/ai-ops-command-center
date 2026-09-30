/**
 * Task handlers by type. The scheduler claims only the types listed here. Phase 3 registers discovery (the
 * Research agent); the planner, verification and the other agents follow in Phases 4 and 5.
 */
import { Budget, ResearchBrief } from '@aoc/contracts';
import { BudgetExhaustedError, evaluateBudget, TaskFailure, toFailure, type ClaimedTask } from '@aoc/core';
import { withWorkspace, type Database } from '@aoc/db';
import type { LlmRouter } from '@aoc/llm';
import { promptHash, runToolLoop, type AgentRole } from './agents/loop';
import { ExecutionRecorder } from './agents/recorder';
import type { TokenMinter } from './agents/tokens';
import type { ToolClient } from './agents/tool-client';
import { discoveryRole, type DiscoveryOutput } from './roles/research';
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
      ])
      .where('id', '=', claim.runId)
      .executeTakeFirstOrThrow(),
  );
}

/** Exhausted budget dimensions right now (nothing left for another call), checked before every model call. */
function budgetChecker(db: Database, claim: ClaimedTask, now: () => Date) {
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
      now(),
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
  const now = deps.now ?? (() => new Date());
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
      checkBudget: budgetChecker(db, claim, now),
      signal,
      now: () => now().getTime(),
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
        { objective: run.objective, criteria: brief.data.criteria, today: today() },
        signal,
      );
      const companies = new Set(
        output.claims.map((c: DiscoveryOutput['claims'][number]) =>
          c.subject.kind === 'new_company' ? c.subject.name.toLowerCase() : '',
        ),
      );
      return {
        kind: 'succeeded',
        summary: { claimsProposed: output.claims.length, companies: companies.size },
        // Phase 4 grounds and persists these claims and expands the graph; until then they live on the execution.
        write: async (tx) => {
          await recorder.succeedInTx(tx, output);
          return {};
        },
      };
    },
  };
}
