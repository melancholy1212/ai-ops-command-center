/**
 * Eval cases (docs/evaluation.md). Phase 3 evaluates discovery at the proposal level: which companies the
 * Research agent proposes, from which sources, at what cost. Grounding and verification expectations join
 * when those steps exist (Phase 4).
 */
import { HttpUrl, InterpretedCriteria, Timestamp, UsdMicros } from '@aoc/contracts';
import { z } from 'zod';

export const EvalMode = z.enum(['replay-all', 'replay-tools', 'live']);
export type EvalMode = z.infer<typeof EvalMode>;

export const EvalCase = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  tags: z.array(z.enum(['happy_path', 'injection', 'egress', 'criteria', 'budget', 'grounding', 'coverage'])),
  scope: z.literal('discover_companies'),
  /** Synthetic fixtures (invented companies and pages) are labelled as such. */
  synthetic: z.boolean(),
  /** Modes the case can run in. Real-web cases are live only: their pages are not committed as fixtures. */
  modes: z.array(EvalMode).min(1).default(['replay-all', 'replay-tools', 'live']),
  input: z.strictObject({
    objective: z.string().min(10),
    briefOverride: InterpretedCriteria,
    seedUrls: z.array(HttpUrl).max(20).default([]),
    /** The clock every component sees, so dates and recency rules are reproducible. */
    frozenNow: Timestamp,
  }),
  fixtures: z.strictObject({
    tools: z.string().min(1),
    model: z.string().min(1),
  }),
  expect: z.strictObject({
    /** Companies the agent should propose (case-insensitive name match). */
    companies: z.array(z.string().min(1)),
    /** Hallucination and injection traps: never proposed. */
    forbiddenCompanies: z.array(z.strictObject({ name: z.string().min(1), why: z.string().min(1) })),
    /** Hosts that must never produce a saved source (egress traps). */
    forbiddenHosts: z.array(z.string().min(1)),
    limits: z.strictObject({
      maxCostUsdMicros: UsdMicros,
      maxLlmCalls: z.int().positive(),
      maxToolCalls: z.int().positive(),
      maxWallClockMs: z.int().positive(),
    }),
  }),
});
export type EvalCase = z.infer<typeof EvalCase>;

/** Recorded tool edges: the search corpus every query returns, and the pages the fetcher serves by URL. */
export const ToolFixtures = z.strictObject({
  synthetic: z.boolean(),
  search: z.array(
    z.strictObject({
      url: z.string().min(1),
      title: z.string(),
      snippet: z.string(),
      publishedAt: Timestamp.nullable(),
    }),
  ),
  pages: z.record(
    z.string(),
    z.strictObject({ status: z.int().default(200), contentType: z.string().default('text/html'), body: z.string() }),
  ),
});
export type ToolFixtures = z.infer<typeof ToolFixtures>;
