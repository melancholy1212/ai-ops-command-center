/** Claim statements are rendered by code from the typed value (docs/domain-model.md); reports show these. */
import type { ClaimAssertion, FundingStage } from '@aoc/contracts';

const STAGE_NAMES: Record<FundingStage, string> = {
  pre_seed: 'pre-seed',
  seed: 'seed',
  series_a: 'Series A',
  series_b: 'Series B',
  series_c: 'Series C',
  series_d_plus: 'Series D or later',
  growth: 'growth',
  grant: 'grant',
  debt: 'debt',
  undisclosed: 'undisclosed-stage',
};

const regions = new Intl.DisplayNames(['en'], { type: 'region' });

export function countryName(code: string): string {
  try {
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
}

const list = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;

export function renderStatement(companyName: string, assertion: ClaimAssertion): string {
  const name = companyName.trim();
  let text: string;
  switch (assertion.attribute) {
    case 'company.website':
      text = `${name}'s website is ${assertion.value.url}.`;
      break;
    case 'company.hq_country':
      text = `${name} is headquartered in ${countryName(assertion.value.country)}.`;
      break;
    case 'company.hq_city':
      text = `${name} is based in ${assertion.value.city}.`;
      break;
    case 'company.founded_year':
      text = `${name} was founded in ${String(assertion.value.year)}.`;
      break;
    case 'company.description':
      text = `${name}: ${assertion.value.text}`;
      break;
    case 'company.sector':
      text = `${name} works in ${list(assertion.value.tags)}.`;
      break;
    case 'company.funding_round': {
      const v = assertion.value;
      const amount =
        v.amount !== null && v.currency !== null
          ? `${v.currency} ${v.amount.toLocaleString('en-US')}`
          : 'an undisclosed amount';
      const lead = v.leadInvestors.length > 0 ? `, led by ${list(v.leadInvestors)}` : '';
      text = `${name} announced a ${STAGE_NAMES[v.stage]} round of ${amount} on ${v.announcedOn}${lead}.`;
      break;
    }
    case 'company.employee_count':
      text =
        assertion.value.max === null
          ? `${name} has at least ${String(assertion.value.min)} employees.`
          : `${name} has ${String(assertion.value.min)}-${String(assertion.value.max)} employees.`;
      break;
    case 'company.hiring_signal':
      text = `${name} is hiring: ${assertion.value.summary}`;
      break;
    case 'company.registry_id':
      text = `${name} is registered as ${assertion.value.scheme} ${assertion.value.id}.`;
      break;
    case 'person.current_role':
      text = `${name} is ${assertion.value.title}.`;
      break;
    case 'person.public_profile':
      text = `${name}'s public profile: ${assertion.value.url}.`;
      break;
  }
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}
