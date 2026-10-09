/**
 * Eval cases (docs/evaluation.md). Two scopes:
 * - discover_companies: the Research agent at the proposal level (which companies, from which sources, at what
 *   cost), with recorded or live model and tools.
 * - verification: discovery is scripted (it opens the case's pages through the real MCP pipeline and proposes
 *   the case's claims); grounding, the verifier model, policy, confidence and the report run for real. Only the
 *   verifier's small calls are recorded, so these cases are cheap to record.
 */
import {
  ClaimAssertion,
  ClaimAttribute,
  ClaimStatus,
  ConfidenceLevel,
  HttpUrl,
  InterpretedCriteria,
  IsoDate,
  PersonRole,
  Timestamp,
  UsdMicros,
  VerificationReasonCode,
} from '@aoc/contracts';
import { z } from 'zod';

export const EvalMode = z.enum(['replay-all', 'replay-tools', 'live']);
export type EvalMode = z.infer<typeof EvalMode>;

const Tags = z.array(
  z.enum(['happy_path', 'injection', 'egress', 'criteria', 'budget', 'grounding', 'coverage', 'verification']),
);

export const DiscoveryCase = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  tags: Tags,
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
export type DiscoveryCase = z.infer<typeof DiscoveryCase>;

/** A claim as the scripted discovery proposes it: evidence names the page by URL (its source id comes later). */
const CaseClaim = z.strictObject({
  subject: z.strictObject({
    kind: z.literal('new_company'),
    name: z.string().min(1),
    domainHint: z.string().nullable(),
  }),
  assertion: ClaimAssertion,
  rawValue: z.string().min(1),
  evidence: z
    .array(z.strictObject({ url: HttpUrl, quote: z.string().min(20) }))
    .min(1)
    .max(3),
});
export type CaseClaim = z.infer<typeof CaseClaim>;

/** A role a page names, by company name: the company's id is only known when the run has resolved it. */
const PeopleCaseClaim = z.strictObject({
  company: z.string().min(1),
  fullName: z.string().min(3),
  title: z.string().min(2),
  role: PersonRole,
  since: IsoDate.nullable().default(null),
  rawValue: z.string().min(1),
  evidence: z
    .array(z.strictObject({ url: HttpUrl, quote: z.string().min(20) }))
    .min(1)
    .max(3),
});
export type PeopleCaseClaim = z.infer<typeof PeopleCaseClaim>;

export const VerificationCase = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  tags: Tags,
  scope: z.literal('verification'),
  synthetic: z.boolean(),
  modes: z.array(EvalMode).min(1).default(['replay-all', 'replay-tools']),
  input: z.strictObject({
    objective: z.string().min(10),
    briefOverride: InterpretedCriteria,
    frozenNow: Timestamp,
    claims: z.array(CaseClaim).min(1).max(30),
    /**
     * What the company's own pages say (workflow version 2): the scripted profile of each company opens these
     * claims' pages and proposes them about the company it profiles. Pages must be reachable as links from the
     * discovery pages, as on the web; the subject name picks the company.
     */
    profileClaims: z.array(CaseClaim).max(30).default([]),
    /**
     * Who the pages name (workflow version 3): the scripted people search of each company opens these pages and
     * proposes these roles at the company it searches. Pages are fetchable as pages the user named.
     */
    peopleClaims: z.array(PeopleCaseClaim).max(30).default([]),
  }),
  fixtures: z.strictObject({ tools: z.string().min(1), model: z.string().min(1) }),
  expect: z.strictObject({
    /** Every company the run resolves, by name: entity resolution must produce exactly these. */
    companies: z.array(z.string().min(1)),
    claims: z.array(
      z.strictObject({
        company: z.string().min(1),
        attribute: ClaimAttribute,
        /** Tells apart two claims of one attribute (e.g. the amounts of a contested round). */
        statementIncludes: z.string().min(1).optional(),
        status: ClaimStatus,
        confidence: ConfidenceLevel.nullable().optional(),
        confidenceScore: z.number().min(0).max(1).optional(),
        reasonsInclude: z.array(VerificationReasonCode).default([]),
        reasonsExclude: z.array(VerificationReasonCode).default([]),
      }),
    ),
    report: z.strictObject({
      ranked: z.array(z.string().min(1)),
      excluded: z.array(z.strictObject({ company: z.string().min(1), reasonIncludes: z.string().min(1) })),
      /** For ranked companies: the decision makers' full names, in report order. */
      decisionMakers: z.record(z.string(), z.array(z.string())).optional(),
    }),
    /** Hosts whose saved snapshot must carry the suspected_prompt_injection flag. */
    flaggedHosts: z.array(z.string().min(1)).default([]),
    limits: z.strictObject({
      maxCostUsdMicros: UsdMicros,
      maxLlmCalls: z.int().positive(),
      maxWallClockMs: z.int().positive(),
    }),
  }),
});
export type VerificationCase = z.infer<typeof VerificationCase>;

export const EvalCase = z.discriminatedUnion('scope', [DiscoveryCase, VerificationCase]);
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
