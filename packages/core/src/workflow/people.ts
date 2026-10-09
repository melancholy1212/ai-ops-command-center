/**
 * find_people (docs/workflow.md, docs/agents.md#people-discovery): what code does around the People Discovery agent.
 * Before it runs, code hands it the company's own pages read in this run (team pages are usually linked from them).
 * Afterwards, code keeps only role claims at this company about named people, drops anything that looks like a
 * contact detail, resolves each name to a person of this company, and grounds and writes the claims exactly like
 * the company's own. A person is never resolved on the name alone: two people at different companies can share it.
 */
import type { CompanyId, ProposedClaim } from '@aoc/contracts';
import type { WorkspaceTransaction } from '@aoc/db';
import { normalizePersonName } from '../verification/identity';
import { loadCitedSources, writeCompanyClaims, type ClaimWriteContext } from './discovery';

/** Contact details of any kind are never stored (docs/agents.md#people-discovery). */
const CONTACT_PATTERNS = [
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i, // e-mail
  /\+?\d[\d\s().-]{7,}\d/, // phone number
  /https?:\/\/|www\./i, // address or profile link
];

export function looksLikeContactDetail(text: string): boolean {
  return CONTACT_PATTERNS.some((pattern) => pattern.test(text));
}

export interface CompanyForPeople {
  id: CompanyId;
  name: string;
  domain: string | null;
  /** The company's own pages saved in this run (fetchable by URL; team pages are usually linked from them). */
  companyPages: { sourceId: string; url: string }[];
  /** Pages already saved as evidence for the company in this run. */
  evidencePages: { sourceId: string; url: string | null }[];
  knownFacts: string[];
}

export async function loadCompanyForPeople(
  tx: WorkspaceTransaction,
  runId: string,
  companyId: string,
): Promise<CompanyForPeople> {
  const company = await tx
    .selectFrom('companies')
    .select(['id', 'name', 'primary_domain'])
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  const fetchedHere = tx
    .selectFrom('tool_calls')
    .select((eb) => eb.fn<string>('unnest', ['created_source_ids']).as('source_id'))
    .where('run_id', '=', runId);
  const companyPages = company.primary_domain
    ? await tx
        .selectFrom('sources')
        .select(['id', 'final_url'])
        .where('registrable_domain', '=', company.primary_domain)
        .where('id', 'in', fetchedHere)
        .orderBy('final_url')
        .limit(10)
        .execute()
    : [];
  const evidence = await tx
    .selectFrom('evidence as e')
    .innerJoin('claims as c', 'c.id', 'e.claim_id')
    .innerJoin('sources as s', 's.id', 'e.source_id')
    .leftJoin('discovered_urls as d', 'd.id', 's.discovered_url_id')
    .select(['s.id', 'd.normalized_url'])
    .distinct()
    .where('c.run_id', '=', runId)
    .where('c.subject_company_id', '=', companyId)
    .where('c.subject_person_id', 'is', null)
    .where('c.status', '!=', 'rejected')
    .where('e.grounding', '!=', 'not_found')
    .orderBy('s.id')
    .execute();
  const claims = await tx
    .selectFrom('claims')
    .select('statement')
    .where('run_id', '=', runId)
    .where('subject_company_id', '=', companyId)
    .where('subject_person_id', 'is', null)
    .where('status', '!=', 'rejected')
    .orderBy('attribute')
    .orderBy('statement')
    .execute();
  return {
    id: company.id as CompanyId,
    name: company.name,
    domain: company.primary_domain,
    companyPages: companyPages.map((p) => ({ sourceId: p.id, url: p.final_url })),
    evidencePages: evidence.slice(0, 10).map((e) => ({ sourceId: e.id, url: e.normalized_url })),
    knownFacts: claims.map((c) => c.statement).slice(0, 20),
  };
}

export interface PeopleResult {
  personIds: string[];
  claimIds: string[];
  sourceIds: string[];
  grounded: number;
  rejected: number;
  /** Proposals that were not role claims at this company about a named person. */
  dropped: number;
  /** Proposals dropped because they carried something that looks like a contact detail. */
  droppedContactDetails: number;
}

/** The person behind a proposal: a full name of at least two words, or a person of this company by id. */
function personName(proposal: ProposedClaim): string | null {
  if (proposal.subject.kind !== 'new_person') return null;
  const name = proposal.subject.fullName.trim().replace(/\s+/g, ' ');
  return name.split(' ').length >= 2 ? name : null;
}

/**
 * Resolves a name to a person of this company: the same normalised name with a claim already anchored to the
 * company (in any run), else a new person. People are workspace knowledge, so a later run finds the same person.
 */
async function resolvePerson(
  tx: WorkspaceTransaction,
  ctx: ClaimWriteContext,
  companyId: string,
  fullName: string,
): Promise<{ id: string; name: string }> {
  const normalized = normalizePersonName(fullName);
  const known = await tx
    .selectFrom('people as p')
    .innerJoin('claims as c', 'c.subject_person_id', 'p.id')
    .select(['p.id', 'p.full_name'])
    .where('p.normalized_name', '=', normalized)
    .where('c.subject_company_id', '=', companyId)
    .orderBy('p.created_at')
    .executeTakeFirst();
  if (known) return { id: known.id, name: known.full_name };
  const created = await tx
    .insertInto('people')
    .values({
      workspace_id: ctx.run.workspace_id,
      full_name: fullName.slice(0, 120),
      normalized_name: normalized,
      first_seen_run_id: ctx.run.id,
    })
    .returning(['id', 'full_name'])
    .executeTakeFirstOrThrow();
  return { id: created.id, name: created.full_name };
}

/**
 * find_people's write, inside its completion transaction: role claims at this company about named people are
 * resolved to people and written; everything else is dropped and counted.
 */
export async function persistPeople(
  tx: WorkspaceTransaction,
  ctx: ClaimWriteContext,
  companyId: string,
  proposals: readonly ProposedClaim[],
): Promise<PeopleResult> {
  const company = await tx
    .selectFrom('companies')
    .select(['id', 'name'])
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  let droppedContactDetails = 0;
  const byName = new Map<string, { name: string; proposals: ProposedClaim[] }>();
  for (const proposal of proposals) {
    const name = personName(proposal);
    const { assertion } = proposal;
    if (name === null || assertion.attribute !== 'person.current_role' || assertion.value.companyId !== company.id)
      continue;
    if ([name, proposal.rawValue, assertion.value.title].some(looksLikeContactDetail)) {
      droppedContactDetails += 1;
      continue;
    }
    const key = normalizePersonName(name);
    const group = byName.get(key) ?? { name, proposals: [] };
    group.proposals.push(proposal);
    byName.set(key, group);
  }
  const kept = [...byName.values()].flatMap((g) => g.proposals);
  const sources = await loadCitedSources(tx, kept);
  const personIds: string[] = [];
  const groundedById = new Map<string, boolean>();
  for (const group of byName.values()) {
    const person = await resolvePerson(tx, ctx, company.id, group.name);
    personIds.push(person.id);
    const written = await writeCompanyClaims(tx, ctx, company, group.proposals, sources, person);
    for (const w of written) groundedById.set(w.claimId, (groundedById.get(w.claimId) ?? false) || w.grounded);
  }
  const grounded = [...groundedById.values()].filter(Boolean).length;
  return {
    personIds,
    claimIds: [...groundedById.keys()],
    sourceIds: [...sources.keys()],
    grounded,
    rejected: groundedById.size - grounded,
    dropped: proposals.length - kept.length - droppedContactDetails,
    droppedContactDetails,
  };
}
