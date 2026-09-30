/**
 * Consistency (docs/provenance.md#verification, step 5): a conflicting value for the same company and
 * attribute makes both claims contested. Rounds of different stages are different facts, not a conflict;
 * the same round conflicts when amounts differ by more than 5 % or dates by more than 14 days. Sector tags
 * merge instead of conflicting; free text (description, hiring) never conflicts.
 */
import type { ClaimAssertion } from '@aoc/contracts';
import { registrableDomainOf } from './identity';

export interface ConsistencyInput {
  id: string;
  assertion: ClaimAssertion;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function conflicts(a: ClaimAssertion, b: ClaimAssertion): boolean {
  if (a.attribute !== b.attribute) return false;
  switch (a.attribute) {
    case 'company.funding_round': {
      if (b.attribute !== 'company.funding_round') return false;
      if (a.value.stage !== b.value.stage) return false;
      const amountConflict =
        a.value.amount !== null &&
        b.value.amount !== null &&
        a.value.currency === b.value.currency &&
        Math.abs(a.value.amount - b.value.amount) > 0.05 * Math.max(a.value.amount, b.value.amount);
      const dateConflict = Math.abs(Date.parse(a.value.announcedOn) - Date.parse(b.value.announcedOn)) > 14 * DAY_MS;
      return amountConflict || dateConflict;
    }
    case 'company.hq_country':
      return b.attribute === 'company.hq_country' && a.value.country !== b.value.country;
    case 'company.hq_city':
      return (
        b.attribute === 'company.hq_city' && a.value.city.trim().toLowerCase() !== b.value.city.trim().toLowerCase()
      );
    case 'company.founded_year':
      return b.attribute === 'company.founded_year' && a.value.year !== b.value.year;
    case 'company.website':
      return b.attribute === 'company.website' && registrableDomainOf(a.value.url) !== registrableDomainOf(b.value.url);
    default:
      return false;
  }
}

/** For each claim, the ids of the claims it conflicts with (claims without conflicts are absent). */
export function findConflicts(claims: readonly ConsistencyInput[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const a = claims[i];
      const b = claims[j];
      if (!a || !b || !conflicts(a.assertion, b.assertion)) continue;
      out.set(a.id, [...(out.get(a.id) ?? []), b.id]);
      out.set(b.id, [...(out.get(b.id) ?? []), a.id]);
    }
  }
  return out;
}
