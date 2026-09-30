/**
 * Source classification at fetch time. Tier here is the source's general standing; whether a company's own
 * site is authoritative (tier A) depends on the attribute and is decided by verification (Phase 4).
 * Heuristic flags are signals that lower confidence, never the defence (docs/provenance.md#prompt-injection).
 */
import type { SourceFlag, SourceTier, SourceType } from '@aoc/contracts';
import { getDomain } from 'tldts';

export const CLASSIFIER_VERSION = 'classify@1';

/** Curated reputable business and technology outlets (tier B), v1. */
const TIER_B_NEWS = new Set([
  'reuters.com',
  'bloomberg.com',
  'ft.com',
  'wsj.com',
  'economist.com',
  'nytimes.com',
  'theguardian.com',
  'bbc.co.uk',
  'bbc.com',
  'cnbc.com',
  'forbes.com',
  'businessinsider.com',
  'techcrunch.com',
  'theverge.com',
  'wired.com',
  'venturebeat.com',
  'sifted.eu',
  'tech.eu',
  'eu-startups.com',
  'theinformation.com',
  'axios.com',
  'handelsblatt.com',
  'lesechos.fr',
  'lemonde.fr',
  'elpais.com',
  'corriere.it',
  'dn.se',
  'di.se',
  'breakit.se',
  'arcticstartup.com',
  'computerweekly.com',
  'zdnet.com',
  'arstechnica.com',
  'fortune.com',
  'finsmes.com',
  'uktech.news',
]);
const PRESS_WIRES = new Set([
  'prnewswire.com',
  'globenewswire.com',
  'businesswire.com',
  'einpresswire.com',
  'newswire.com',
  'accesswire.com',
  'cision.com',
  'mynewsdesk.com',
]);
const KNOWLEDGE_BASES = new Set(['wikipedia.org', 'wikidata.org', 'crunchbase.com', 'dealroom.co', 'pitchbook.com']);
const USER_GENERATED = new Set([
  'reddit.com',
  'quora.com',
  'news.ycombinator.com',
  'ycombinator.com',
  'stackexchange.com',
  'youtube.com',
]);
const BLOG_HOSTS = new Set([
  'medium.com',
  'substack.com',
  'wordpress.com',
  'blogspot.com',
  'ghost.io',
  'dev.to',
  'hashnode.dev',
]);

export function registrableDomain(host: string): string {
  return getDomain(host) ?? host;
}

export function classifySource(host: string): { sourceType: SourceType; tier: SourceTier } {
  const domain = registrableDomain(host);
  if (PRESS_WIRES.has(domain)) return { sourceType: 'press_release', tier: 'C' };
  if (TIER_B_NEWS.has(domain)) return { sourceType: 'news_article', tier: 'B' };
  if (KNOWLEDGE_BASES.has(domain)) return { sourceType: 'knowledge_base', tier: 'C' };
  if (USER_GENERATED.has(domain) || host === 'news.ycombinator.com') return { sourceType: 'other', tier: 'D' };
  if (BLOG_HOSTS.has(domain)) return { sourceType: 'blog', tier: 'C' };
  return { sourceType: 'other', tier: 'C' };
}

const INJECTION_PATTERNS = [
  /ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|prompts|messages)/i,
  /disregard (all |any )?(the )?(previous|prior|above) /i,
  /\b(system|developer) prompt\b/i,
  /you are (now )?(an? )?(ai|assistant|language model|chatgpt|claude|gpt)\b/i,
  /<\/?(system|assistant|instructions?|tool_call)>/i,
  /\b(web_search|fetch_page|get_source|search_knowledge|lookup_company|find_company_people|submit_result)\b/,
  /new instructions:/i,
];

export function sourceFlags(text: string, hadInvisibleCharacters: boolean): SourceFlag[] {
  const flags: SourceFlag[] = [];
  if (hadInvisibleCharacters || INJECTION_PATTERNS.some((p) => p.test(text))) flags.push('suspected_prompt_injection');
  if (
    text.length < 1500 &&
    /(subscribe to (continue|read)|already a subscriber|sign in to (continue|read)|subscribers only)/i.test(text)
  ) {
    flags.push('paywall_suspected');
  }
  if (text.length < 500) flags.push('thin_content');
  return flags;
}
