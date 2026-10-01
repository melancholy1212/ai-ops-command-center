/**
 * Funding-news outlets by the countries they cover (docs/workflow.md#targeted-search). Code chooses them from
 * the brief's countries, the way region names become country lists, and the plan shows them before research
 * starts. Discovery searches them first: live runs found real rounds when searches were limited to a funding-
 * news site, and mostly roundups and listicles otherwise. A curated starting list, to be extended by review.
 */
const NORDICS_BALTICS = ['SE', 'NO', 'DK', 'FI', 'IS', 'EE', 'LV', 'LT'];
const EUROPE = [
  ...NORDICS_BALTICS,
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'CH',
  'GB',
];

export const OUTLETS_VERSION = 'outlets@1';

export const FUNDING_NEWS_OUTLETS: readonly { domain: string; covers: readonly string[] }[] = [
  // Regional outlets first: they report the small rounds pan-European sites skip.
  { domain: 'arcticstartup.com', covers: NORDICS_BALTICS },
  { domain: 'breakit.se', covers: ['SE'] },
  { domain: 'shifter.no', covers: ['NO'] },
  { domain: 'trendingtopics.eu', covers: ['AT', 'DE', 'CH'] },
  { domain: 'deutsche-startups.de', covers: ['DE'] },
  { domain: 'startupticker.ch', covers: ['CH'] },
  { domain: 'maddyness.com', covers: ['FR'] },
  { domain: 'siliconcanals.com', covers: ['NL', 'BE', 'LU'] },
  { domain: 'uktech.news', covers: ['GB'] },
  { domain: 'siliconrepublic.com', covers: ['IE'] },
  { domain: 'elreferente.es', covers: ['ES', 'PT'] },
  { domain: 'startupitalia.eu', covers: ['IT'] },
  { domain: 'betakit.com', covers: ['CA'] },
  // Pan-European, then global.
  { domain: 'eu-startups.com', covers: EUROPE },
  { domain: 'tech.eu', covers: EUROPE },
  { domain: 'techfundingnews.com', covers: [...EUROPE, 'US', 'CA'] },
  { domain: 'techcrunch.com', covers: [...EUROPE, 'US', 'CA'] },
];

export const MAX_NEWS_OUTLETS = 8;

/** The outlets that cover any of the countries, regional before pan-European, at most MAX_NEWS_OUTLETS. */
export function newsOutletsFor(countries: readonly string[]): string[] {
  return FUNDING_NEWS_OUTLETS.filter((o) => o.covers.some((c) => countries.includes(c)))
    .map((o) => o.domain)
    .slice(0, MAX_NEWS_OUTLETS);
}
