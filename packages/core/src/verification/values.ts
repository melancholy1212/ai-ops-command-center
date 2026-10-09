/**
 * Value in quote (docs/provenance.md#verification, step 2): where an attribute has a detectable surface form
 * (amounts, stages, countries, cities, years), the claimed value must appear in the quote or its sentence.
 * Returns null when the attribute has no reliable surface form (description, sector, website...).
 */
import type { ClaimAssertion, FundingStage } from '@aoc/contracts';
import { normalizeForMatch } from './text';

/** Country names and demonyms, for the countries the product targets first. */
const COUNTRY_FORMS: Record<string, string[]> = {
  SE: ['sweden', 'swedish', 'stockholm', 'gothenburg', 'malmo', 'malmö', 'uppsala'],
  NO: ['norway', 'norwegian', 'oslo', 'bergen', 'stavanger', 'trondheim'],
  DK: ['denmark', 'danish', 'copenhagen', 'aarhus', 'odense'],
  FI: ['finland', 'finnish', 'helsinki', 'espoo', 'tampere', 'oulu', 'turku'],
  IS: ['iceland', 'icelandic', 'reykjavik', 'reykjavík'],
  EE: ['estonia', 'estonian', 'tallinn', 'tartu'],
  LV: ['latvia', 'latvian', 'riga'],
  LT: ['lithuania', 'lithuanian', 'vilnius', 'kaunas'],
  GB: [
    'united kingdom',
    'uk',
    'britain',
    'british',
    'england',
    'english',
    'scotland',
    'scottish',
    'wales',
    'welsh',
    'london',
    'manchester',
    'edinburgh',
    'cambridge',
    'oxford',
  ],
  IE: ['ireland', 'irish', 'dublin', 'cork'],
  DE: ['germany', 'german', 'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne'],
  FR: ['france', 'french', 'paris', 'lyon', 'toulouse'],
  NL: ['netherlands', 'dutch', 'amsterdam', 'rotterdam', 'utrecht', 'eindhoven'],
  BE: ['belgium', 'belgian', 'brussels', 'antwerp', 'ghent'],
  ES: ['spain', 'spanish', 'madrid', 'barcelona', 'valencia'],
  PT: ['portugal', 'portuguese', 'lisbon', 'porto'],
  IT: ['italy', 'italian', 'milan', 'rome', 'turin'],
  CH: ['switzerland', 'swiss', 'zurich', 'zürich', 'geneva', 'lausanne'],
  AT: ['austria', 'austrian', 'vienna'],
  PL: ['poland', 'polish', 'warsaw', 'krakow', 'kraków'],
  CZ: ['czech', 'czechia', 'prague', 'brno'],
  US: [
    'united states',
    'usa',
    'u.s.',
    'american',
    'new york',
    'san francisco',
    'boston',
    'denver',
    'austin',
    'seattle',
    'los angeles',
    'chicago',
    'silicon valley',
  ],
  CA: ['canada', 'canadian', 'toronto', 'vancouver', 'montreal'],
  IL: ['israel', 'israeli', 'tel aviv'],
};

const STAGE_FORMS: Record<FundingStage, RegExp> = {
  pre_seed: /\bpre[- ]?seed\b/,
  seed: /\bseed\b/,
  series_a: /\bseries a\b/,
  series_b: /\bseries b\b/,
  series_c: /\bseries c\b/,
  series_d_plus: /\bseries [d-z]\b/,
  growth: /\bgrowth\b/,
  grant: /\bgrant\b/,
  debt: /\b(debt|loan|credit facility)\b/,
  undisclosed: /./,
};

const MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mn: 1e6,
  mio: 1e6,
  million: 1e6,
  millions: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
};

/** Every money-like amount in the text, in whole units ("EUR 4.2 million" -> 4200000, "4,000,000" -> 4000000). */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  const pattern = /(\d{1,3}(?:[ ,]\d{3})+|\d+(?:[.,]\d+)?)\s*(thousand|millions|million|billion|mio|mn|bn|k|m|b)?\b/g;
  for (const match of text.toLowerCase().matchAll(pattern)) {
    const digits = match[1] ?? '';
    const grouped = /^\d{1,3}(?:[ ,]\d{3})+$/.test(digits);
    const number = grouped ? Number(digits.replace(/[ ,]/g, '')) : Number(digits.replace(',', '.'));
    if (!Number.isFinite(number)) continue;
    out.push(number * (MULTIPLIERS[match[2] ?? ''] ?? 1));
  }
  return out;
}

const hasWord = (text: string, form: string) =>
  new RegExp(`(^|[^\\p{L}])${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(text);

/** Whether the claimed value appears in the text (quote plus its sentence); null when not checkable. */
export function valueInText(assertion: ClaimAssertion, text: string): boolean | null {
  const normalized = normalizeForMatch(text).text;
  switch (assertion.attribute) {
    case 'company.funding_round': {
      const { amount, stage } = assertion.value;
      const stageOk = stage === 'undisclosed' || STAGE_FORMS[stage].test(normalized);
      const amountOk = amount === null || amountsIn(normalized).some((a) => Math.abs(a - amount) <= amount * 0.01);
      return stageOk && amountOk;
    }
    case 'company.hq_country': {
      const forms = COUNTRY_FORMS[assertion.value.country];
      return forms ? forms.some((form) => hasWord(normalized, form)) : null;
    }
    case 'company.hq_city':
      return hasWord(normalized, normalizeForMatch(assertion.value.city).text);
    case 'person.current_role': {
      // The title as stated: every word of it (short connectives aside) appears near the quote.
      const words = normalizeForMatch(assertion.value.title)
        .text.split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 2 && !['and', 'och', 'og', 'the', 'for'].includes(w));
      return words.length === 0 ? null : words.every((w) => hasWord(normalized, w));
    }
    case 'company.founded_year':
      return hasWord(normalized, String(assertion.value.year));
    default:
      return null;
  }
}
