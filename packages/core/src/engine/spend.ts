import type { Actor, RunId, Spend, WorkspaceId } from '@aoc/contracts';
import { withWorkspace, type Database, type WorkspaceTransaction } from '@aoc/db';
import { crossedThresholds } from '../budget';
import { appendEvent } from './events';
import { lockRun, runBudget, runSpend } from './runs';

/**
 * Adds real spend to the run, including spend of attempts that later failed. Crossing 50, 80 or 100 %
 * of the cost budget is recorded on the timeline.
 */
export async function recordSpendInTx(tx: WorkspaceTransaction, runId: RunId, delta: Partial<Spend>, actor: Actor) {
  const run = await lockRun(tx, runId);
  const before = runSpend(run);
  const after: Spend = {
    costUsdMicros: before.costUsdMicros + (delta.costUsdMicros ?? 0),
    llmInputTokens: before.llmInputTokens + (delta.llmInputTokens ?? 0),
    llmOutputTokens: before.llmOutputTokens + (delta.llmOutputTokens ?? 0),
    toolCalls: before.toolCalls + (delta.toolCalls ?? 0),
  };
  await tx
    .updateTable('runs')
    .set({
      spend_cost_usd_micros: after.costUsdMicros,
      spend_llm_input_tokens: after.llmInputTokens,
      spend_llm_output_tokens: after.llmOutputTokens,
      spend_tool_calls: after.toolCalls,
      updated_at: new Date(),
    })
    .where('id', '=', runId)
    .execute();
  const budget = runBudget(run);
  for (const percent of crossedThresholds(before, after, budget)) {
    await appendEvent(tx, run, actor, {
      type: 'budget.threshold_crossed',
      data: { percent, spentUsdMicros: after.costUsdMicros, limitUsdMicros: budget.maxCostUsdMicros },
    });
  }
  return after;
}

export async function recordSpend(
  db: Database,
  workspaceId: WorkspaceId,
  runId: RunId,
  delta: Partial<Spend>,
  actor: Actor,
) {
  return withWorkspace(db, workspaceId, (tx) => recordSpendInTx(tx, runId, delta, actor));
}
