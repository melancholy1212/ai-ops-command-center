/**
 * profile_company (docs/workflow.md, docs/agents.md#company-intelligence): what code does around the Company
 * Intelligence agent. Before it runs, code looks for the company's own website among the links on the pages that
 * are already evidence for the company. Afterwards, code pins the agent's proposals to the company it was asked
 * about, grounds and writes them exactly like discovery's, and records the company's domain only when evidence ties
 * the site to the company. The domain is what makes the company's own pages authoritative for self-reported facts
 * (docs/provenance.md#source-tiers), so a model's say-so never sets it: a namesake's site must not verify anything.
 */
import type { CompanyId, ProposedClaim } from '@aoc/contracts';
import { sql } from 'kysely';
import type { WorkspaceTransaction } from '@aoc/db';
import { normalizeCompanyName, registrableDomainOf } from '../verification/identity';
import { loadCitedSources, writeCompanyClaims, type ClaimWriteContext } from './discovery';

/** Sites that host profiles of many companies: a link to one is never the company's own website. */
const PLATFORM_DOMAINS = new Set([
  'linkedin.com',
  'x.com',
  'twitter.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'tiktok.com',
  'threads.net',
  'bsky.app',
  'medium.com',
  'substack.com',
  'github.com',
  'crunchbase.com',
  'dealroom.co',
  'pitchbook.com',
  'wikipedia.org',
  'apple.com',
  'google.com',
]);

export interface LinkCandidate {
  url: string;
  /** Null when the link has no text (an image link, say): such a link names nothing. */
  anchorText: string | null;
  /** Registrable domain of the page the link was found on. */
  fromDomain: string;
  fromSourceId: string;
}

export interface LinkedWebsite {
  url: string;
  domain: string;
  /** The evidence page that links to it. */
  fromSourceId: string;
}

/**
 * Rule A: a link whose anchor text is the company's name, on a page that is evidence for the company, to a site of
 * another domain that is not a platform. Two different sites linked under the name is ambiguous: no website.
 */
export function websiteFromLinks(companyName: string, links: readonly LinkCandidate[]): LinkedWebsite | null {
  const name = normalizeCompanyName(companyName);
  const byDomain = new Map<string, LinkedWebsite>();
  for (const link of links) {
    if (link.anchorText === null || normalizeCompanyName(link.anchorText) !== name) continue;
    const domain = registrableDomainOf(link.url);
    if (!domain || domain === link.fromDomain || PLATFORM_DOMAINS.has(domain) || byDomain.has(domain)) continue;
    byDomain.set(domain, { url: link.url, domain, fromSourceId: link.fromSourceId });
  }
  return byDomain.size === 1 ? ([...byDomain.values()][0] ?? null) : null;
}

/** Rule B: the domain written out in a page's text ("Display.dev raises €470,000" names display.dev). */
export function mentionsDomain(text: string, domain: string): boolean {
  const escaped = domain.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`, 'u').test(text.toLowerCase());
}

interface EvidencePage {
  sourceId: string;
  registrableDomain: string;
  url: string | null;
  text: string;
}

/** Pages holding grounded evidence for the company's standing claims in this run. */
async function evidencePages(tx: WorkspaceTransaction, runId: string, companyId: string): Promise<EvidencePage[]> {
  const rows = await tx
    .selectFrom('evidence as e')
    .innerJoin('claims as c', 'c.id', 'e.claim_id')
    .innerJoin('sources as s', 's.id', 'e.source_id')
    .leftJoin('discovered_urls as d', 'd.id', 's.discovered_url_id')
    .select(['s.id', 's.registrable_domain', 'd.normalized_url', 's.text'])
    .distinct()
    .where('c.run_id', '=', runId)
    .where('c.subject_company_id', '=', companyId)
    .where('c.status', '!=', 'rejected')
    .where('e.grounding', '!=', 'not_found')
    .orderBy('s.id')
    .execute();
  return rows.map((r) => ({
    sourceId: r.id,
    registrableDomain: r.registrable_domain,
    url: r.normalized_url,
    text: r.text,
  }));
}

async function linkedWebsite(
  tx: WorkspaceTransaction,
  runId: string,
  name: string,
  pages: readonly EvidencePage[],
): Promise<LinkedWebsite | null> {
  if (pages.length === 0) return null;
  const domainOf = new Map(pages.map((p) => [p.sourceId, p.registrableDomain]));
  const links = await tx
    .selectFrom('discovered_urls')
    .select([
      'normalized_url',
      sql<string | null>`origin->>'anchorText'`.as('anchor_text'),
      sql<string>`origin->>'fromSourceId'`.as('from_source_id'),
    ])
    .where('run_id', '=', runId)
    .where('origin_kind', '=', 'page_link')
    .where(sql<string>`origin->>'fromSourceId'`, 'in', [...domainOf.keys()])
    .orderBy('discovered_at')
    .execute();
  return websiteFromLinks(
    name,
    links.map((l) => ({
      url: l.normalized_url,
      anchorText: l.anchor_text,
      fromDomain: domainOf.get(l.from_source_id) ?? '',
      fromSourceId: l.from_source_id,
    })),
  );
}

export interface CompanyToProfile {
  id: CompanyId;
  name: string;
  primaryDomain: string | null;
  /** The company's own site, when an evidence page links to it (Rule A). Fetchable in this run. */
  website: LinkedWebsite | null;
  /** Statements of the claims discovery made, for the agent's orientation. */
  knownFacts: string[];
  /** Evidence pages the agent may reopen: get_source by id, or fetch_page by URL. */
  evidencePages: { sourceId: string; url: string | null }[];
}

export async function loadCompanyToProfile(
  tx: WorkspaceTransaction,
  runId: string,
  companyId: string,
): Promise<CompanyToProfile> {
  const company = await tx
    .selectFrom('companies')
    .select(['id', 'name', 'primary_domain'])
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  const claims = await tx
    .selectFrom('claims')
    .select('statement')
    .where('run_id', '=', runId)
    .where('subject_company_id', '=', companyId)
    .where('status', '!=', 'rejected')
    .orderBy('attribute')
    .orderBy('statement')
    .execute();
  const pages = await evidencePages(tx, runId, companyId);
  return {
    id: company.id as CompanyId,
    name: company.name,
    primaryDomain: company.primary_domain,
    website: company.primary_domain ? null : await linkedWebsite(tx, runId, company.name, pages),
    knownFacts: claims.map((c) => c.statement).slice(0, 30),
    evidencePages: pages.slice(0, 10).map((p) => ({ sourceId: p.sourceId, url: p.url })),
  };
}

export interface ProfileResult {
  claimIds: string[];
  sourceIds: string[];
  grounded: number;
  rejected: number;
  /** Proposals about another company than the one profiled. */
  dropped: number;
  /** The domain recorded for the company in this profile, and the rule that tied it to the company. */
  domain: { value: string; rule: 'linked_from_evidence' | 'named_in_evidence' } | null;
  /** Why a domain the evidence supports was not recorded. */
  domainNotRecorded: string | null;
}

/**
 * Is a proposal about the company being profiled? Its own subject ({kind: "company", companyId}), or a new-company
 * subject with its name or the domain the evidence gave it. Anything else (an investor, a customer) is dropped.
 */
function aboutCompany(
  proposal: ProposedClaim,
  company: { id: string; name: string },
  domains: ReadonlySet<string>,
): boolean {
  const { subject } = proposal;
  if (subject.kind === 'company') return subject.companyId === company.id;
  if (subject.kind !== 'new_company') return false;
  if (normalizeCompanyName(subject.name) === normalizeCompanyName(company.name)) return true;
  const hinted = registrableDomainOf(subject.domainHint);
  return hinted !== null && domains.has(hinted);
}

/**
 * Rule B over the run's rows: grounded website claims whose domain another evidence page writes out. Only pages that
 * were evidence before the profile count: they are what identified the company. A page the profiler found by
 * searching the name may be about a namesake, so it never ties a domain (as a site found that way never does).
 */
async function namedWebsiteDomain(
  tx: WorkspaceTransaction,
  runId: string,
  companyId: string,
  pages: readonly EvidencePage[],
): Promise<string | null> {
  const websites = await tx
    .selectFrom('claims')
    .select('value')
    .where('run_id', '=', runId)
    .where('subject_company_id', '=', companyId)
    .where('attribute', '=', 'company.website')
    .where('status', '!=', 'rejected')
    .execute();
  const candidates = new Set(
    websites
      .map((w) => registrableDomainOf((w.value as { url?: string }).url))
      .filter((d): d is string => d !== null && !PLATFORM_DOMAINS.has(d)),
  );
  const named = [...candidates].filter((domain) =>
    pages.some((p) => p.registrableDomain !== domain && mentionsDomain(p.text, domain)),
  );
  return named.length === 1 ? (named[0] ?? null) : null;
}

/**
 * The profile's domain write, run inside profile_company's completion transaction: proposals about the company
 * are grounded and written (others are dropped), then the company's domain is recorded if it has none and the
 * evidence ties one site to it.
 */
export async function persistProfile(
  tx: WorkspaceTransaction,
  ctx: ClaimWriteContext,
  companyId: string,
  proposals: readonly ProposedClaim[],
): Promise<ProfileResult> {
  const company = await tx
    .selectFrom('companies')
    .select(['id', 'name', 'primary_domain'])
    .where('id', '=', companyId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  const before = await evidencePages(tx, ctx.run.id, company.id);
  const linked = company.primary_domain ? null : await linkedWebsite(tx, ctx.run.id, company.name, before);
  const known = new Set([company.primary_domain, linked?.domain].filter((d): d is string => Boolean(d)));
  const kept = proposals.filter((p) => aboutCompany(p, company, known));
  const sources = await loadCitedSources(tx, kept);
  const written = await writeCompanyClaims(tx, ctx, company, kept, sources);

  const groundedById = new Map<string, boolean>();
  for (const w of written) groundedById.set(w.claimId, (groundedById.get(w.claimId) ?? false) || w.grounded);
  const grounded = [...groundedById.values()].filter(Boolean).length;
  const result: ProfileResult = {
    claimIds: [...groundedById.keys()],
    sourceIds: [...sources.keys()],
    grounded,
    rejected: groundedById.size - grounded,
    dropped: proposals.length - kept.length,
    domain: null,
    domainNotRecorded: null,
  };
  if (company.primary_domain) return result;

  let domain: ProfileResult['domain'] = linked ? { value: linked.domain, rule: 'linked_from_evidence' } : null;
  if (!domain) {
    const named = await namedWebsiteDomain(tx, ctx.run.id, company.id, before);
    if (named) domain = { value: named, rule: 'named_in_evidence' };
  }
  if (!domain) return result;
  // Entity resolution keys companies by domain: a domain another company holds is not this one's to take.
  const holder = await tx
    .selectFrom('companies')
    .select('name')
    .where('primary_domain', '=', domain.value)
    .where('id', '!=', company.id)
    .executeTakeFirst();
  if (holder) return { ...result, domainNotRecorded: `${domain.value} already belongs to ${holder.name}.` };
  await tx
    .updateTable('companies')
    .set({ primary_domain: domain.value, updated_at: ctx.now })
    .where('id', '=', company.id)
    .execute();
  return { ...result, domain };
}
