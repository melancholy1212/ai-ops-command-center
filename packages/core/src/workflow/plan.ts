/**
 * The plan (docs/workflow.md#what-each-step-guarantees): the planner proposes an interpretation of the
 * objective; code normalises it. Region names become explicit country lists from a static table, the funding
 * window is validated and clamped to today, limits are clamped, workflow-version limits are applied, and every
 * default or change is recorded as an Assumption the user sees before approving. Code also adds the estimate.
 */
import {
  FundingStage,
  InterpretedCriteria,
  PersonRole,
  type PlanSnapshot,
  type Assumption,
  type Budget,
  type ResearchBrief,
} from '@aoc/contracts';
import { z } from 'zod';
import { TASK_COST_ESTIMATES } from '../budget';
import { newsOutletsFor } from './outlets';

/** What the planner model returns. Code turns it into InterpretedCriteria (docs/agents.md#planner). */
export const PlannerProposal = z.strictObject({
  sectorKeywords: z.array(z.string().trim().min(2).max(60)).min(1).max(15),
  /** Region names ("Nordics", "DACH", "Europe") and/or ISO 3166-1 alpha-2 codes. */
  places: z.array(z.string().trim().min(2).max(60)).min(1).max(60),
  fundingWindow: z.strictObject({ from: z.iso.date(), to: z.iso.date() }).nullable(),
  fundingStages: z.array(FundingStage).max(10),
  maxCompanies: z.int().min(1).max(25).nullable(),
  peopleRoles: z.array(PersonRole).max(8),
  assumptions: z
    .array(
      z.strictObject({
        field: z.string().min(1).max(100),
        assumed: z.string().min(1).max(300),
        reason: z.string().min(1).max(500),
      }),
    )
    .max(12),
  openQuestions: z.array(z.string().min(1).max(300)).max(10),
});
export type PlannerProposal = z.infer<typeof PlannerProposal>;

const NORDICS = ['SE', 'NO', 'DK', 'FI', 'IS'];
const BALTICS = ['EE', 'LV', 'LT'];
const EU27 = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
];

/** Static region table: the only way a region name becomes countries. */
export const REGIONS: Record<string, readonly string[]> = {
  nordics: NORDICS,
  nordic: NORDICS,
  'nordic countries': NORDICS,
  scandinavia: ['SE', 'NO', 'DK'],
  baltics: BALTICS,
  'baltic states': BALTICS,
  dach: ['DE', 'AT', 'CH'],
  benelux: ['BE', 'NL', 'LU'],
  'european union': EU27,
  eu: EU27,
  europe: [...EU27, 'GB', 'NO', 'CH', 'IS'],
  uk: ['GB'],
  'united kingdom': ['GB'],
  britain: ['GB'],
  'great britain': ['GB'],
  iberia: ['ES', 'PT'],
  'north america': ['US', 'CA'],
};

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
/** Codes Intl names that are not countries: supranational groupings and pseudo-locales. */
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB']);
function isCountryCode(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code) || NOT_COUNTRIES.has(code)) return false;
  try {
    // Unassigned and private-use codes come back unnamed ("Unknown Region") or as the code itself.
    const name = regionNames.of(code);
    return name !== undefined && name !== code && name !== 'Unknown Region';
  } catch {
    return false;
  }
}

export const PLAN_DEFAULTS = {
  maxCompanies: 5,
  maxCompaniesCap: 10,
  windowMonths: 12,
  peopleRoles: ['founder', 'ceo'] as PersonRole[],
};

function monthsBefore(today: string, months: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

export interface NormalizedPlan {
  criteria: InterpretedCriteria;
  assumptions: Assumption[];
  openQuestions: string[];
}

export function normalizePlan(proposal: PlannerProposal, today: string): NormalizedPlan {
  const assumptions: Assumption[] = proposal.assumptions.map((a) => ({ ...a }));
  const assume = (field: string, assumed: string, reason: string) => {
    assumptions.push({ field, assumed: assumed.slice(0, 300), reason: reason.slice(0, 500) });
  };

  // Places: regions expand by the table; codes must be real ISO codes; anything else is dropped and said so.
  const countries: string[] = [];
  const add = (code: string) => {
    if (!countries.includes(code)) countries.push(code);
  };
  for (const place of proposal.places) {
    const region = REGIONS[place.trim().toLowerCase()];
    const code = place.trim().toUpperCase();
    if (region) {
      region.forEach(add);
      assume('countries', region.join(', '), `"${place}" expanded by the region table.`);
    } else if (isCountryCode(code)) add(code);
    else assume('countries', `(ignored) ${place}`, `"${place}" is neither a known region nor an ISO country code.`);
  }
  if (countries.length === 0) {
    NORDICS.forEach(add);
    assume('countries', NORDICS.join(', '), 'No usable place in the objective; defaulted to the Nordics.');
  }

  // Funding window: explicit and valid, never in the future; default the last 12 months.
  let window = proposal.fundingWindow;
  if (!window) {
    window = { from: monthsBefore(today, PLAN_DEFAULTS.windowMonths), to: today };
    assume(
      'fundingWindow',
      `${window.from} to ${window.to}`,
      'No funding period given; defaulted to the last 12 months.',
    );
  } else {
    if (window.to > today) {
      assume('fundingWindow.to', today, `The end ${window.to} is in the future; clamped to today.`);
      window = { ...window, to: today };
    }
    if (window.from > window.to) {
      const from = monthsBefore(window.to, PLAN_DEFAULTS.windowMonths);
      assume('fundingWindow.from', from, `The start was after the end; set to 12 months before ${window.to}.`);
      window = { ...window, from };
    }
  }

  let maxCompanies = proposal.maxCompanies ?? PLAN_DEFAULTS.maxCompanies;
  if (proposal.maxCompanies === null)
    assume('maxCompanies', String(maxCompanies), 'No number of companies given; the default.');
  if (maxCompanies > PLAN_DEFAULTS.maxCompaniesCap) {
    assume(
      'maxCompanies',
      String(PLAN_DEFAULTS.maxCompaniesCap),
      `${String(maxCompanies)} requested; clamped to the project maximum.`,
    );
    maxCompanies = PLAN_DEFAULTS.maxCompaniesCap;
  }

  let peopleRoles = [...new Set(proposal.peopleRoles)];
  if (peopleRoles.length === 0) {
    peopleRoles = PLAN_DEFAULTS.peopleRoles;
    assume('peopleRoles', peopleRoles.join(', '), 'No roles given; decision makers by default.');
  }
  // Workflow version 1 has no outreach step; the plan says so instead of promising drafts.
  assume('outreach', 'disabled', 'Outreach drafting is not part of this workflow version.');

  const newsOutlets = newsOutletsFor(countries);
  if (newsOutlets.length > 0)
    assume('newsOutlets', newsOutlets.join(', '), 'Funding-news outlets for these countries, from the outlet table.');

  const criteria = InterpretedCriteria.parse({
    sectorKeywords: [...new Set(proposal.sectorKeywords.map((k) => k.trim()))],
    countries: countries.slice(0, 60),
    fundingWindow: window,
    fundingStages: [...new Set(proposal.fundingStages)],
    maxCompanies,
    peopleRoles,
    outreach: { enabled: false, maxCompanies: 0 },
    ...(newsOutlets.length > 0 ? { newsOutlets } : {}),
  });
  return { criteria, assumptions: assumptions.slice(0, 20), openQuestions: proposal.openQuestions };
}

/**
 * A range from per-task estimates: the plan call, discovery, one verification per company (from workflow version 2,
 * one profile per company too; from version 3, a people search per company too), the report.
 */
export function planEstimate(
  criteria: InterpretedCriteria,
  workflowVersion: number,
): { costUsdMicrosLow: number; costUsdMicrosHigh: number } {
  const perCompany =
    TASK_COST_ESTIMATES.structured_llm.costUsdMicros +
    (workflowVersion >= 2 ? TASK_COST_ESTIMATES.agent_loop.costUsdMicros : 0) +
    (workflowVersion >= 3 ? TASK_COST_ESTIMATES.agent_loop.costUsdMicros : 0);
  const base =
    TASK_COST_ESTIMATES.structured_llm.costUsdMicros +
    TASK_COST_ESTIMATES.agent_loop.costUsdMicros +
    criteria.maxCompanies * perCompany;
  return { costUsdMicrosLow: Math.round(base * 0.5), costUsdMicrosHigh: Math.round(base * 1.5) };
}

/** Exactly what the user approves: the brief as saved, the budget, the estimate. Frozen and hashed by the engine. */
export function planSnapshot(
  brief: ResearchBrief,
  budget: Budget,
  workflowVersion: number,
): z.infer<typeof PlanSnapshot> {
  return {
    kind: 'plan',
    objective: brief.objective,
    criteria: brief.criteria,
    assumptions: brief.assumptions,
    budget,
    estimate: planEstimate(brief.criteria, workflowVersion),
    workflowVersion,
  };
}
