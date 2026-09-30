/**
 * Criteria (docs/provenance.md#verification, step 7): a claim that takes the company outside the brief
 * excludes it with OUTSIDE_CRITERIA, e.g. a headquarters outside the country list, or a funding round
 * outside the window or of another stage.
 */
import type { ClaimAssertion, InterpretedCriteria } from '@aoc/contracts';

export function outsideCriteria(assertion: ClaimAssertion, criteria: InterpretedCriteria): string | null {
  if (assertion.attribute === 'company.hq_country') {
    return criteria.countries.includes(assertion.value.country)
      ? null
      : `Headquartered in ${assertion.value.country}, outside ${criteria.countries.join(', ')}.`;
  }
  if (assertion.attribute === 'company.funding_round') {
    const { announcedOn, stage } = assertion.value;
    if (announcedOn < criteria.fundingWindow.from || announcedOn > criteria.fundingWindow.to) {
      return `Round announced ${announcedOn}, outside ${criteria.fundingWindow.from} to ${criteria.fundingWindow.to}.`;
    }
    if (criteria.fundingStages.length > 0 && !criteria.fundingStages.includes(stage)) {
      return `A ${stage} round; the brief asks for ${criteria.fundingStages.join(', ')}.`;
    }
  }
  return null;
}
