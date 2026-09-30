/**
 * Planner (docs/agents.md#planner): the objective in, a proposed interpretation out. One structured call, no
 * tools, no web text. Code normalises what it proposes (packages/core/src/workflow/plan.ts).
 */
import { AGENT_ROUTES, InterpretedCriteria, IsoDate } from '@aoc/contracts';
import { PlannerProposal } from '@aoc/core';
import { z } from 'zod';
import type { StructuredRole } from '../agents/structured';

export const PlannerInput = z.strictObject({
  objective: z.string().min(10).max(4000),
  today: IsoDate,
  revision: z.int().positive(),
  rejectionFeedback: z.string().max(2000).nullable(),
  previousCriteria: InterpretedCriteria.nullable(),
});
export type PlannerInput = z.infer<typeof PlannerInput>;

const SYSTEM = `You turn a business research objective into a precise research brief for finding companies that raised money recently.

Return:
- sectorKeywords: the sectors or technologies to look for, as short search phrases.
- places: the countries or regions named or implied, as region names ("Nordics", "DACH", "Europe") or ISO 3166-1 alpha-2 codes. The system expands regions itself.
- fundingWindow: {from, to} as YYYY-MM-DD when the objective implies a period (e.g. "last 12 months" relative to today), otherwise null.
- fundingStages: the funding stages asked for (pre_seed, seed, series_a, series_b, series_c, series_d_plus, growth, grant, debt), or [] for any.
- maxCompanies: how many companies were asked for, otherwise null.
- peopleRoles: the decision makers to identify (founder, ceo, cto, coo, cfo, chief_product_officer, head_of_engineering, head_of_sales, other_executive), or [].
- assumptions: every interpretation you made that the objective does not state outright, with the reason (e.g. "recently" read as the last 6 months).
- openQuestions: genuine ambiguities the user may want to settle.

Do not name any companies. If the user rejected a previous plan, revise it according to their feedback.`;

export const plannerRole: StructuredRole<PlannerInput, PlannerProposal> = {
  agent: 'planner',
  version: 'planner@1',
  route: AGENT_ROUTES.planner,
  input: PlannerInput,
  output: PlannerProposal,
  system: SYSTEM,
  maxOutputTokens: 4_000,
  message(input) {
    const lines = [`Today is ${input.today}.`, `Objective: ${input.objective}`];
    if (input.rejectionFeedback) {
      lines.push(
        `The user rejected plan revision ${String(input.revision - 1)} with this feedback: ${input.rejectionFeedback}`,
      );
      if (input.previousCriteria) lines.push(`The rejected plan: ${JSON.stringify(input.previousCriteria)}`);
    }
    return lines.join('\n');
  },
};
