import { describe, expect, it } from 'vitest';
import { normalizePlan, planEstimate, type PlannerProposal } from './plan';

const proposal = (overrides: Partial<PlannerProposal> = {}): PlannerProposal => ({
  sectorKeywords: ['climate software', 'climate software', 'carbon accounting'],
  places: ['Nordics'],
  fundingWindow: { from: '2025-09-30', to: '2026-09-30' },
  fundingStages: ['seed', 'seed'],
  maxCompanies: 3,
  peopleRoles: ['founder'],
  assumptions: [],
  openQuestions: [],
  ...overrides,
});
const TODAY = '2026-09-30';

describe('normalizePlan', () => {
  it('expands regions by the table and says so', () => {
    const plan = normalizePlan(proposal({ places: ['Nordics', 'DE', 'Baltics'] }), TODAY);
    expect(plan.criteria.countries).toEqual(['SE', 'NO', 'DK', 'FI', 'IS', 'DE', 'EE', 'LV', 'LT']);
    expect(plan.assumptions.filter((a) => a.field === 'countries').map((a) => a.reason)).toEqual([
      '"Nordics" expanded by the region table.',
      '"Baltics" expanded by the region table.',
    ]);
    expect(plan.criteria.sectorKeywords).toEqual(['climate software', 'carbon accounting']);
    expect(plan.criteria.fundingStages).toEqual(['seed']);
  });

  it('drops places that are neither regions nor real country codes, and defaults when nothing is left', () => {
    const plan = normalizePlan(proposal({ places: ['Atlantis', 'ZZ', 'XA', 'EZ'] }), TODAY);
    expect(plan.criteria.countries).toEqual(['SE', 'NO', 'DK', 'FI', 'IS']);
    expect(plan.assumptions.map((a) => a.assumed)).toEqual(
      expect.arrayContaining(['(ignored) Atlantis', '(ignored) ZZ', '(ignored) XA', '(ignored) EZ']),
    );
  });

  it('defaults the funding window to the last 12 months and never lets it reach into the future', () => {
    expect(normalizePlan(proposal({ fundingWindow: null }), TODAY).criteria.fundingWindow).toEqual({
      from: '2025-09-30',
      to: '2026-09-30',
    });
    const future = normalizePlan(proposal({ fundingWindow: { from: '2026-01-01', to: '2027-06-01' } }), TODAY);
    expect(future.criteria.fundingWindow).toEqual({ from: '2026-01-01', to: TODAY });
    expect(future.assumptions.map((a) => a.field)).toContain('fundingWindow.to');
    const inverted = normalizePlan(proposal({ fundingWindow: { from: '2026-08-01', to: '2026-02-01' } }), TODAY);
    expect(inverted.criteria.fundingWindow).toEqual({ from: '2025-02-01', to: '2026-02-01' });
  });

  it('clamps the number of companies, fills defaults, and disables outreach in this workflow version', () => {
    const plan = normalizePlan(proposal({ maxCompanies: 25, peopleRoles: [] }), TODAY);
    expect(plan.criteria.maxCompanies).toBe(10);
    expect(plan.criteria.peopleRoles).toEqual(['founder', 'ceo']);
    expect(plan.criteria.outreach).toEqual({ enabled: false, maxCompanies: 0 });
    expect(plan.assumptions.map((a) => a.field)).toEqual(
      expect.arrayContaining(['maxCompanies', 'peopleRoles', 'outreach']),
    );
    expect(normalizePlan(proposal({ maxCompanies: null }), TODAY).criteria.maxCompanies).toBe(5);
  });

  it('keeps the planner assumptions and adds its own after them', () => {
    const plan = normalizePlan(
      proposal({ assumptions: [{ field: 'fundingWindow', assumed: 'last 12 months', reason: '"recently"' }] }),
      TODAY,
    );
    expect(plan.assumptions[0]).toEqual({ field: 'fundingWindow', assumed: 'last 12 months', reason: '"recently"' });
  });
});

describe('planEstimate', () => {
  it('scales with the number of companies and gives a range', () => {
    const small = planEstimate(normalizePlan(proposal({ maxCompanies: 1 }), TODAY).criteria);
    const large = planEstimate(normalizePlan(proposal({ maxCompanies: 10 }), TODAY).criteria);
    expect(small.costUsdMicrosLow).toBeLessThan(small.costUsdMicrosHigh);
    expect(large.costUsdMicrosHigh).toBeGreaterThan(small.costUsdMicrosHigh);
  });
});
