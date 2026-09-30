import type { Budget, Spend, TaskExecutionKind } from '@aoc/contracts';

export type BudgetDimension = 'cost' | 'tokens' | 'toolCalls' | 'wallClock';

export interface CostEstimate {
  costUsdMicros: number;
  llmTokens: number;
  toolCalls: number;
}

/** Default run budget: $2, 6M tokens, 600 tool calls, 1 hour. Projects can override it. */
export const DEFAULT_RUN_BUDGET: Budget = {
  maxCostUsdMicros: 2_000_000,
  maxLlmTokens: 6_000_000,
  maxToolCalls: 600,
  maxWallClockSeconds: 3_600,
};

/**
 * Conservative per-task estimates, used to refuse work that would not fit in the remaining budget.
 * Phase 3 replaces the model-backed numbers with averages measured from telemetry.
 */
export const TASK_COST_ESTIMATES: Record<TaskExecutionKind, CostEstimate> = {
  code: { costUsdMicros: 0, llmTokens: 0, toolCalls: 0 },
  human_gate: { costUsdMicros: 0, llmTokens: 0, toolCalls: 0 },
  structured_llm: { costUsdMicros: 20_000, llmTokens: 20_000, toolCalls: 0 },
  agent_loop: { costUsdMicros: 150_000, llmTokens: 150_000, toolCalls: 30 },
};

export interface BudgetState {
  budget: Budget;
  spend: Spend;
  startedAt: Date | null;
}

/** Would starting work with this estimate stay within every budget dimension? */
export function evaluateBudget(
  state: BudgetState,
  estimate: CostEstimate,
  now: Date,
): { ok: boolean; exhausted: BudgetDimension[] } {
  const { budget, spend } = state;
  const exhausted: BudgetDimension[] = [];
  if (spend.costUsdMicros + estimate.costUsdMicros > budget.maxCostUsdMicros) exhausted.push('cost');
  if (spend.llmInputTokens + spend.llmOutputTokens + estimate.llmTokens > budget.maxLlmTokens) exhausted.push('tokens');
  if (spend.toolCalls + estimate.toolCalls > budget.maxToolCalls) exhausted.push('toolCalls');
  if (state.startedAt && now.getTime() - state.startedAt.getTime() > budget.maxWallClockSeconds * 1000) {
    exhausted.push('wallClock');
  }
  return { ok: exhausted.length === 0, exhausted };
}

const CEILINGS: Budget = {
  maxCostUsdMicros: 100_000_000,
  maxLlmTokens: 50_000_000,
  maxToolCalls: 5_000,
  maxWallClockSeconds: 86_400,
};

/** The extension offered for approval: each exhausted dimension raised by half, within the hard ceilings. */
export function proposeExtension(budget: Budget, exhausted: readonly BudgetDimension[], factor = 1.5): Budget {
  const raise = (value: number, ceiling: number) => Math.min(Math.ceil(value * factor), ceiling);
  return {
    maxCostUsdMicros: exhausted.includes('cost')
      ? raise(budget.maxCostUsdMicros, CEILINGS.maxCostUsdMicros)
      : budget.maxCostUsdMicros,
    maxLlmTokens: exhausted.includes('tokens')
      ? raise(budget.maxLlmTokens, CEILINGS.maxLlmTokens)
      : budget.maxLlmTokens,
    maxToolCalls: exhausted.includes('toolCalls')
      ? raise(budget.maxToolCalls, CEILINGS.maxToolCalls)
      : budget.maxToolCalls,
    maxWallClockSeconds: exhausted.includes('wallClock')
      ? raise(budget.maxWallClockSeconds, CEILINGS.maxWallClockSeconds)
      : budget.maxWallClockSeconds,
  };
}

/** Cost thresholds (percent of the budget) crossed by moving from `before` to `after`. */
export function crossedThresholds(before: Spend, after: Spend, budget: Budget): (50 | 80 | 100)[] {
  const limit = budget.maxCostUsdMicros;
  if (limit <= 0) return [];
  return ([50, 80, 100] as const).filter(
    (percent) => before.costUsdMicros * 100 < percent * limit && after.costUsdMicros * 100 >= percent * limit,
  );
}
