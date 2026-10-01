import type { ClaimAssertion, InterpretedCriteria } from '@aoc/contracts';
import { describe, expect, it } from 'vitest';
import {
  amountsIn,
  claimFingerprint,
  computeConfidence,
  contextAround,
  dateFitsPublication,
  evaluatePolicy,
  findConflicts,
  groundQuote,
  independentGroups,
  judgeStatement,
  normalizeCompanyName,
  normalizeForMatch,
  outsideCriteria,
  quoteShapeProblem,
  registrableDomainOf,
  renderStatement,
  sentenceAround,
  valueInText,
  type EvidenceFeatures,
} from './index';

const NBH = String.fromCodePoint(0x2011); // non-breaking hyphen
const RSQ = String.fromCodePoint(0x2019); // right single quote
const LDQ = String.fromCodePoint(0x201c);
const RDQ = String.fromCodePoint(0x201d);
const ELL = String.fromCodePoint(0x2026);
const ROCKET = String.fromCodePoint(0x1f680);

const round = (
  overrides: Partial<Extract<ClaimAssertion, { attribute: 'company.funding_round' }>['value']> = {},
): ClaimAssertion => ({
  attribute: 'company.funding_round',
  value: {
    stage: 'seed',
    amount: 4_000_000,
    currency: 'EUR',
    announcedOn: '2026-03-12',
    leadInvestors: ['Nordic Seed Partners'],
    otherInvestors: [],
    ...overrides,
  },
});

describe('normalisation', () => {
  it('folds dashes, quotes, whitespace, case and invisible characters, keeping a map to the original', () => {
    const original = `Co${NBH}founder  ${LDQ}Elin${RDQ}\nStrand${String.fromCodePoint(0x200b)} said`;
    const n = normalizeForMatch(original);
    expect(n.text).toBe('co-founder "elin" strand said');
    // "s" of "said" maps back to its position in the original.
    expect(Array.from(original)[n.map[n.text.indexOf('said')] ?? 0]).toBe('s');
  });
});

describe('grounding', () => {
  const page = `Stockholm-based Northwind Climate has raised a EUR 4 million seed round led by Nordic Seed Partners. The company${RSQ}s co-founder Elin Strand said the funding will take it to Norway and Finland. ${ROCKET} Launch day.`;

  it('finds verbatim quotes and returns code point spans', () => {
    const quote = 'Northwind Climate has raised a EUR 4 million seed round';
    const g = groundQuote(page, quote);
    expect(g).toMatchObject({ result: 'exact', problem: null });
    expect(Array.from(page).slice(g.spans[0]?.start, g.spans[0]?.end).join('')).toBe(quote);
  });

  it('matches after normalisation: the non-breaking hyphen gpt-oss-120b wrote, straight quotes, case', () => {
    const g = groundQuote(page, `"The company's co${NBH}founder ELIN STRAND said the funding"`);
    expect(g.result).toBe('normalized');
    expect(Array.from(page).slice(g.spans[0]?.start, g.spans[0]?.end).join('')).toBe(
      `The company${RSQ}s co-founder Elin Strand said the funding`,
    );
  });

  it('accepts elided quotes when every segment is long enough, in order and close together (the Qwen pattern)', () => {
    const g = groundQuote(
      page,
      `Northwind Climate has raised a EUR 4 million seed round${ELL}the funding will take it to Norway and Finland`,
    );
    expect(g.result).toBe('elided_segments');
    expect(g.spans).toHaveLength(2);
    expect(
      groundQuote(page, 'the funding will take it to Norway... Northwind Climate has raised a EUR 4 million').result,
    ).toBe('not_found');
    expect(groundQuote(page, 'Northwind Climate has raised a EUR 4 million seed round... Norway').result).toBe(
      'not_found',
    );
  });

  it('rejects elided segments that are in order but too far apart to be one statement', () => {
    const far = `Northwind Climate has raised a EUR 4 million seed round. ${'Unrelated filler text. '.repeat(80)}The funding will take it to Norway and Finland.`;
    expect(
      groundQuote(
        far,
        'Northwind Climate has raised a EUR 4 million seed round... The funding will take it to Norway and Finland',
      ).result,
    ).toBe('not_found');
    const near = `Northwind Climate has raised a EUR 4 million seed round. ${'Filler. '.repeat(10)}The funding will take it to Norway and Finland.`;
    expect(
      groundQuote(
        near,
        'Northwind Climate has raised a EUR 4 million seed round... The funding will take it to Norway and Finland',
      ).result,
    ).toBe('elided_segments');
  });

  it('rejects quotes that are too short to be evidence, and quotes that are not there', () => {
    expect(groundQuote(page, 'Stockholm')).toMatchObject({ result: 'not_found', problem: 'QUOTE_TOO_SHORT' });
    expect(groundQuote(page, 'Northwind Climate has raised a EUR 5 million seed round')).toMatchObject({
      result: 'not_found',
      problem: 'QUOTE_NOT_FOUND',
    });
  });

  it('keeps spans correct after characters outside the Basic Multilingual Plane', () => {
    const g = groundQuote(page, `${ROCKET} Launch day. `.trim() + ' ');
    expect(g.result).toBe('not_found'); // two words only
    const later = groundQuote(
      `${ROCKET}${ROCKET} Northwind Climate raised a seed round`,
      'Northwind Climate raised a seed round',
    );
    expect(later.spans[0]).toEqual({ start: 3, end: 3 + 'Northwind Climate raised a seed round'.length });
  });

  it('gives the sentence and a context window around a span', () => {
    const g = groundQuote(page, 'co-founder Elin Strand said the funding');
    const span = g.spans[0] ?? { start: 0, end: 0 };
    expect(sentenceAround(page, span)).toContain('take it to Norway and Finland.');
    expect(contextAround(page, span, 10).length).toBeLessThan(80);
  });
});

describe('value in quote', () => {
  it('finds amounts in their usual written forms', () => {
    expect(amountsIn('raised EUR 4 million')).toContain(4_000_000);
    expect(amountsIn('a €4M round')).toContain(4_000_000);
    expect(amountsIn('SEK 44,100,000 in total')).toContain(44_100_000);
    expect(amountsIn('$4.6 million (SEK 44.1 million)')).toEqual(expect.arrayContaining([4_600_000, 44_100_000]));
  });

  it('requires the stage and amount of a funding round', () => {
    expect(valueInText(round(), 'Northwind has raised a EUR 4 million seed round.')).toBe(true);
    expect(valueInText(round(), 'Northwind has raised a EUR 4 million Series A.')).toBe(false);
    expect(valueInText(round(), 'Northwind has raised a seed round of EUR 5 million.')).toBe(false);
    expect(valueInText(round({ amount: null, currency: null }), 'Northwind closed an undisclosed seed round.')).toBe(
      true,
    );
    expect(valueInText(round({ stage: 'pre_seed' }), 'a EUR 4m pre-seed round')).toBe(true);
  });

  it('recognises countries by name, demonym or main city, and cities and years by name', () => {
    const se: ClaimAssertion = { attribute: 'company.hq_country', value: { country: 'SE' } };
    expect(valueInText(se, 'Stockholm-based Northwind')).toBe(true);
    expect(valueInText(se, 'the Swedish startup')).toBe(true);
    expect(valueInText(se, 'the Oslo startup')).toBe(false);
    expect(valueInText({ attribute: 'company.hq_country', value: { country: 'KE' } }, 'Nairobi')).toBeNull();
    expect(
      valueInText({ attribute: 'company.hq_city', value: { city: 'Stavanger' } }, 'based in Stavanger, Norway'),
    ).toBe(true);
    expect(valueInText({ attribute: 'company.founded_year', value: { year: 2023 } }, 'founded in 2023')).toBe(true);
    expect(valueInText({ attribute: 'company.sector', value: { tags: ['climate'] } }, 'anything')).toBeNull();
  });
});

describe('independence', () => {
  const release =
    'Northwind Climate today announced a EUR 4 million seed round led by Nordic Seed Partners to expand its carbon accounting platform across the Nordics.';
  it('counts the same domain once and syndicated copies of one release once', () => {
    const { groups, syndicated } = independentGroups([
      { id: 'a', registrableDomain: 'news-one.example', context: release },
      { id: 'b', registrableDomain: 'news-two.example', context: `Reprint: ${release}` },
      {
        id: 'c',
        registrableDomain: 'news-one.example',
        context: 'A different article about the same company and its plans.',
      },
      {
        id: 'd',
        registrableDomain: 'independent.example',
        context: 'Our reporter spoke to the founders about their seed funding and their hiring plans for next year.',
      },
    ]);
    expect(groups).toHaveLength(2);
    expect(syndicated).toEqual([['a', 'b']]);
  });
});

function evidence(overrides: Partial<EvidenceFeatures> = {}): EvidenceFeatures {
  return {
    evidenceId: overrides.evidenceId ?? 'e1',
    sourceId: 's1',
    registrableDomain: 'news-one.example',
    tier: 'B',
    sourceType: 'news_article',
    flags: [],
    publishedAt: new Date('2026-03-12T08:00:00Z'),
    retrievedAt: new Date('2026-09-30T12:00:00Z'),
    grounding: 'exact',
    valueInQuote: true,
    judge: 'supports',
    context: 'Northwind Climate raised a EUR 4 million seed round.',
    selfPublished: false,
    ...overrides,
  };
}

describe('policy v1', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  it('verifies a funding round with one authoritative source (the company or its press release)', () => {
    expect(
      evaluatePolicy(round(), [evidence({ selfPublished: true, tier: 'C', registrableDomain: 'northwind.example' })])
        .status,
    ).toBe('verified');
    expect(evaluatePolicy(round(), [evidence({ sourceType: 'press_release', tier: 'C' })]).status).toBe('verified');
  });

  it('verifies with two independent tier-B sources, otherwise probable', () => {
    const two = evaluatePolicy(round(), [
      evidence(),
      evidence({
        evidenceId: 'e2',
        registrableDomain: 'news-two.example',
        context: 'Our reporter talked to the founders about why investors backed them this spring.',
      }),
    ]);
    expect([two.status, two.independentSources]).toEqual(['verified', 2]);
    const one = evaluatePolicy(round(), [evidence()]);
    expect(one.status).toBe('probable');
    expect(one.reasons.map((r) => r.code)).toContain('SINGLE_SOURCE');
  });

  it('does not let syndicated copies count as independent', () => {
    const release =
      'Northwind Climate today announced a EUR 4 million seed round led by Nordic Seed Partners to expand across the Nordics.';
    const copies = evaluatePolicy(round(), [
      evidence({ context: release }),
      evidence({ evidenceId: 'e2', registrableDomain: 'news-two.example', context: release }),
    ]);
    expect(copies.status).toBe('probable');
    expect(copies.reasons.map((r) => r.code)).toContain('SYNDICATED_DUPLICATE');
  });

  it('rejects ungrounded, contradicted, unsupported or value-less evidence', () => {
    expect(evaluatePolicy(round(), [evidence({ grounding: 'not_found' })]).status).toBe('rejected');
    expect(evaluatePolicy(round(), [evidence({ judge: 'contradicts' })]).reasons.map((r) => r.code)).toContain(
      'JUDGE_CONTRADICTS',
    );
    expect(evaluatePolicy(round(), [evidence({ judge: 'does_not_support' })]).status).toBe('rejected');
    expect(evaluatePolicy(round(), [evidence({ valueInQuote: false })]).reasons.map((r) => r.code)).toContain(
      'VALUE_NOT_IN_QUOTE',
    );
    expect(evaluatePolicy(round(), [evidence({ judge: null })]).status).toBe('rejected');
  });

  it('needs the company site plus an independent source to verify a headquarters country', () => {
    const hq: ClaimAssertion = { attribute: 'company.hq_country', value: { country: 'SE' } };
    expect(evaluatePolicy(hq, [evidence({ selfPublished: true, registrableDomain: 'northwind.example' })]).status).toBe(
      'probable',
    );
    expect(
      evaluatePolicy(hq, [
        evidence({
          selfPublished: true,
          registrableDomain: 'northwind.example',
          context: 'We are headquartered in Stockholm.',
        }),
        evidence({ evidenceId: 'e2', context: 'The Stockholm startup builds carbon software for manufacturers.' }),
      ]).status,
    ).toBe('verified');
  });

  it('never trusts user-generated sources alone', () => {
    expect(evaluatePolicy(round(), [evidence({ tier: 'D', registrableDomain: 'reddit.com' })]).status).toBe('rejected');
  });

  it('computes confidence from evidence features and records every penalty', () => {
    const outcome = evaluatePolicy(round(), [
      evidence({ selfPublished: true, registrableDomain: 'northwind.example' }),
    ]);
    expect(computeConfidence('verified', outcome, now)).toMatchObject({ score: 0.9, level: 'high' });
    // An old article about a round of its own time: the date fits, so only age, injection and partial count.
    const old = evaluatePolicy(round({ announcedOn: '2023-12-28' }), [
      evidence({
        publishedAt: new Date('2024-01-01T00:00:00Z'),
        flags: ['suspected_prompt_injection'],
        judge: 'partially_supports',
      }),
    ]);
    const low = computeConfidence('probable', old, now);
    expect(low.score).toBe(0.15);
    expect(low.level).toBe('low');
    expect(low.reasons.map((r) => r.code)).toEqual(['SOURCE_TOO_OLD', 'SUSPECTED_INJECTION_SOURCE']);
    expect(computeConfidence('contested', outcome, now)).toMatchObject({ score: 0.45, level: 'low' });
  });
});

describe('announcement dates', () => {
  it('fit a publication on the day or up to 30 days after, never before', () => {
    const published = new Date('2026-06-02T07:30:00Z');
    expect(dateFitsPublication('2026-06-02', published)).toBe(true);
    expect(dateFitsPublication('2026-06-03', published)).toBe(true); // time zones
    expect(dateFitsPublication('2026-05-03', published)).toBe(true);
    expect(dateFitsPublication('2026-05-02', published)).toBe(false);
    expect(dateFitsPublication('2026-06-04', published)).toBe(false);
    expect(dateFitsPublication('2026-06-02', null)).toBe(false);
  });

  it('are checked by code, not the judge: an unbacked date is recorded and costs confidence', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    const backed = evaluatePolicy(round(), [evidence()]);
    expect([backed.dateUnverified, backed.reasons.map((r) => r.code)]).toEqual([false, ['SINGLE_SOURCE']]);
    const unbacked = evaluatePolicy(round({ announcedOn: '2026-08-01' }), [evidence()]);
    expect(unbacked.status).toBe('probable');
    expect(unbacked.reasons.map((r) => r.code)).toEqual(['SINGLE_SOURCE', 'DATE_UNVERIFIED']);
    expect(computeConfidence('probable', backed, now).score).toBe(0.55);
    expect(computeConfidence('probable', unbacked, now).score).toBe(0.45);
    // Other attributes have no date to check.
    const hq: ClaimAssertion = { attribute: 'company.hq_country', value: { country: 'SE' } };
    expect(evaluatePolicy(hq, [evidence({ publishedAt: null })]).dateUnverified).toBe(false);
  });

  it('are left out of what the judge reads, and kept in what people read', () => {
    expect(judgeStatement('Oplane', round())).toBe(
      'Oplane announced a seed round of EUR 4,000,000, led by Nordic Seed Partners.',
    );
    expect(renderStatement('Oplane', round())).toBe(
      'Oplane announced a seed round of EUR 4,000,000 on 2026-03-12, led by Nordic Seed Partners.',
    );
    const hq: ClaimAssertion = { attribute: 'company.hq_country', value: { country: 'FI' } };
    expect(judgeStatement('Rotomate', hq)).toBe(renderStatement('Rotomate', hq));
  });
});

describe('quote shape', () => {
  it('names what grounding would reject, before any source is consulted', () => {
    expect(quoteShapeProblem(`Stockholm${NBH}based Scape...`)).toMatch(/^has 3 word\(s\)/);
    expect(quoteShapeProblem('"Northwind"')).toMatch(/^has 1 word/);
    expect(quoteShapeProblem('Helsinki-based industrial AI startup Rotomate...')).toBeNull();
    expect(quoteShapeProblem(`Northwind Climate raised money ... in March`)).toMatch(/shorter than 20 characters/);
    expect(
      quoteShapeProblem(`Malmo-based AI security startup Oplane ${ELL} is headquartered in Malmo, Sweden.`),
    ).toBeNull();
    // Whatever the shape check accepts, grounding does not reject for shape.
    expect(groundQuote('Northwind', 'Stockholm based Scape').problem).toBe('QUOTE_TOO_SHORT');
  });
});

describe('consistency', () => {
  it('contests the same round reported with different amounts or dates, not different rounds', () => {
    const conflicts = findConflicts([
      { id: 'a', assertion: round({ amount: 12_000_000 }) },
      { id: 'b', assertion: round({ amount: 15_000_000 }) },
      { id: 'c', assertion: round({ stage: 'series_a', amount: 30_000_000 }) },
      { id: 'd', assertion: round({ amount: 12_200_000 }) },
    ]);
    expect(conflicts.get('a')).toEqual(['b']);
    expect(conflicts.get('b')).toEqual(['a', 'd']);
    expect(conflicts.has('c')).toBe(false);
    expect(
      findConflicts([
        { id: 'x', assertion: round() },
        { id: 'y', assertion: round({ announcedOn: '2026-05-01' }) },
      ]).size,
    ).toBe(2);
  });

  it('contests different countries, cities, years and website domains; never sector tags', () => {
    const hq = (country: string): ClaimAssertion => ({ attribute: 'company.hq_country', value: { country } });
    expect(
      findConflicts([
        { id: 'a', assertion: hq('SE') },
        { id: 'b', assertion: hq('NO') },
      ]).size,
    ).toBe(2);
    const site = (url: string): ClaimAssertion => ({ attribute: 'company.website', value: { url } });
    expect(
      findConflicts([
        { id: 'a', assertion: site('https://www.northwind.example/') },
        { id: 'b', assertion: site('https://northwind.example/about') },
      ]).size,
    ).toBe(0);
    const tags = (t: string[]): ClaimAssertion => ({ attribute: 'company.sector', value: { tags: t } });
    expect(
      findConflicts([
        { id: 'a', assertion: tags(['climate']) },
        { id: 'b', assertion: tags(['fintech']) },
      ]).size,
    ).toBe(0);
  });
});

describe('criteria', () => {
  const criteria: InterpretedCriteria = {
    sectorKeywords: ['climate software'],
    countries: ['SE', 'NO'],
    fundingWindow: { from: '2025-09-30', to: '2026-09-30' },
    fundingStages: ['seed'],
    maxCompanies: 3,
    peopleRoles: ['founder'],
    outreach: { enabled: false, maxCompanies: 0 },
  };
  it('excludes headquarters outside the countries and rounds outside the window or stages', () => {
    expect(outsideCriteria({ attribute: 'company.hq_country', value: { country: 'US' } }, criteria)).toMatch(
      /outside SE, NO/,
    );
    expect(outsideCriteria(round({ announcedOn: '2024-01-01' }), criteria)).toMatch(/outside 2025-09-30/);
    expect(outsideCriteria(round({ stage: 'series_a' }), criteria)).toMatch(/series_a round/);
    expect(outsideCriteria(round(), criteria)).toBeNull();
    expect(outsideCriteria({ attribute: 'company.sector', value: { tags: ['x'] } }, criteria)).toBeNull();
  });
});

describe('identity and statements', () => {
  it('normalises company names and domains so the same company resolves once', () => {
    expect(normalizeCompanyName('Northwind Climate AB')).toBe('northwind climate');
    expect(normalizeCompanyName('NORTHWIND CLIMATE, Ltd.')).toBe('northwind climate');
    expect(registrableDomainOf('https://www.northwind.example/about')).toBe('northwind.example');
    expect(registrableDomainOf('app.northwind.co.uk')).toBe('northwind.co.uk');
    expect(registrableDomainOf('not a domain')).toBeNull();
  });

  it('fingerprints claims by subject, attribute and canonical value', () => {
    const a = claimFingerprint('c1', { attribute: 'company.sector', value: { tags: ['Climate', 'SaaS'] } });
    const b = claimFingerprint('c1', { attribute: 'company.sector', value: { tags: ['saas', 'climate '] } });
    expect(a).toBe(b);
    expect(claimFingerprint('c2', { attribute: 'company.sector', value: { tags: ['saas', 'climate'] } })).not.toBe(a);
  });

  it('renders statements from typed values', () => {
    expect(renderStatement('Northwind Climate', round())).toBe(
      'Northwind Climate announced a seed round of EUR 4,000,000 on 2026-03-12, led by Nordic Seed Partners.',
    );
    expect(renderStatement('Northwind Climate', round({ amount: null, currency: null, leadInvestors: [] }))).toBe(
      'Northwind Climate announced a seed round of an undisclosed amount on 2026-03-12.',
    );
    expect(renderStatement('Northwind Climate', { attribute: 'company.hq_country', value: { country: 'SE' } })).toBe(
      'Northwind Climate is headquartered in Sweden.',
    );
  });
});
