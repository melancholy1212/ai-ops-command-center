/**
 * MCP tool contracts. The MCP server validates every input and output against these, and the
 * worker's MCP client uses the same schemas, so both sides of the boundary agree by construction.
 * Tools are capabilities (research and knowledge reads). Nothing here creates tasks, changes
 * workflow state, decides approvals or writes arbitrary records.
 */
import { z } from 'zod';
import {
  AgentType,
  ClaimId,
  CompanyId,
  Count,
  CountryCode,
  DiscoveredUrlId,
  ExecutionId,
  Hostname,
  HttpUrl,
  IsoDate,
  PersonId,
  PersonRole,
  RegistryScheme,
  RunId,
  Sha256Hex,
  SourceId,
  TaskId,
  Timestamp,
  ToolCallId,
  WorkspaceId,
} from './common';
import { ClaimAttribute, ClaimStatus, ConfidenceLevel } from './claim';
import { SourceFlag, SourceTier } from './provenance';

export const ToolName = z.enum([
  'web_search',
  'fetch_page',
  'lookup_company',
  'find_company_people',
  'search_knowledge',
  'get_source',
]);
export type ToolName = z.infer<typeof ToolName>;

// ---------------------------------------------------------------------------
// Errors: returned as a tool result with isError=true, so the agent can adapt
// and the runtime can decide whether to retry.
// ---------------------------------------------------------------------------
export const ToolErrorCode = z.enum([
  'INVALID_ARGUMENT',
  'UNAUTHENTICATED',
  'TOOL_NOT_PERMITTED',
  'URL_NOT_PERMITTED', // not discovered in this scope (provenance rule)
  'URL_BLOCKED', // egress policy: scheme, port, private address, blocked domain
  'ROBOTS_DISALLOWED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'BUDGET_EXCEEDED',
  'PROVIDER_UNAVAILABLE',
  'UPSTREAM_ERROR',
  'TIMEOUT',
  'CONTENT_TOO_LARGE',
  'UNSUPPORTED_CONTENT_TYPE',
  'NOT_FOUND',
  'UNSUPPORTED_JURISDICTION',
  'INTERNAL',
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCode>;

export const ToolError = z.object({
  code: ToolErrorCode,
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
  retryAfterMs: Count.nullable(),
  toolCallId: ToolCallId,
});
export type ToolError = z.infer<typeof ToolError>;

/** Attached to every successful result: which call produced it, from where, and whether it came from cache. */
export const ToolProvenance = z.object({
  toolCallId: ToolCallId,
  provider: z.string().max(60).nullable(),
  retrievedAt: Timestamp,
  cached: z.boolean(),
});

// ---------------------------------------------------------------------------
// web_search: search the web; every result URL becomes fetchable in this scope.
// ---------------------------------------------------------------------------
export const WebSearchInput = z.strictObject({
  query: z.string().trim().min(3).max(400),
  mode: z.enum(['general', 'news']).default('general'),
  recencyDays: z.int().min(1).max(3650).optional(),
  includeDomains: z.array(Hostname).max(20).optional(),
  excludeDomains: z.array(Hostname).max(20).optional(),
  maxResults: z.int().min(1).max(10).default(5),
});
export const WebSearchOutput = z.object({
  results: z
    .array(
      z.object({
        url: HttpUrl,
        title: z.string().max(500),
        snippet: z.string().max(1000),
        publishedAt: Timestamp.nullable(),
        rank: Count,
        discoveredUrlId: DiscoveredUrlId,
      }),
    )
    .max(10),
  provenance: ToolProvenance,
});

// ---------------------------------------------------------------------------
// fetch_page: fetch an authorised URL, extract text, save a snapshot. Page links become fetchable.
// ---------------------------------------------------------------------------
const PagedText = {
  text: z.string(),
  offset: Count,
  totalChars: Count,
  hasMore: z.boolean(),
};

export const FetchPageInput = z.strictObject({
  url: HttpUrl,
  offset: Count.default(0),
  maxChars: z.int().min(1000).max(20_000).default(8000),
});
export const FetchPageOutput = z.object({
  sourceId: SourceId,
  finalUrl: HttpUrl,
  canonicalUrl: HttpUrl.nullable(),
  title: z.string().max(500).nullable(),
  publishedAt: Timestamp.nullable(),
  retrievedAt: Timestamp,
  contentSha256: Sha256Hex,
  tier: SourceTier,
  flags: z.array(SourceFlag).max(4),
  ...PagedText,
  links: z.array(z.object({ url: HttpUrl, text: z.string().max(300), discoveredUrlId: DiscoveredUrlId })).max(100),
  provenance: ToolProvenance,
});

// ---------------------------------------------------------------------------
// lookup_company: resolve a company to registry-backed records. Each record is saved as a source.
// ---------------------------------------------------------------------------
export const LookupCompanyInput = z.strictObject({
  query: z.discriminatedUnion('by', [
    z.strictObject({ by: z.literal('name'), name: z.string().trim().min(2).max(200), country: CountryCode.optional() }),
    z.strictObject({ by: z.literal('domain'), domain: Hostname }),
    z.strictObject({ by: z.literal('registry_id'), scheme: RegistryScheme, id: z.string().trim().min(1).max(40) }),
  ]),
  maxCandidates: z.int().min(1).max(10).default(5),
});
export const CompanyCandidate = z.object({
  provider: z.string().min(1).max(60),
  providerRecordId: z.string().min(1).max(100),
  legalName: z.string().min(1).max(300),
  otherNames: z.array(z.string().max(300)).max(10),
  country: CountryCode.nullable(),
  registryIds: z.array(z.object({ scheme: RegistryScheme, id: z.string().min(1).max(40) })).max(5),
  status: z.enum(['active', 'inactive', 'dissolved', 'unknown']),
  incorporatedOn: IsoDate.nullable(),
  website: HttpUrl.nullable(),
  /** Set when `website` was recorded as a provider_record URL, i.e. it is now fetchable. */
  websiteDiscoveredUrlId: DiscoveredUrlId.nullable(),
  registeredAddress: z.string().max(500).nullable(),
  sourceId: SourceId,
  /** Computed by code (name similarity, domain match, country), not by a model. */
  matchScore: z.number().min(0).max(1),
  matchReasons: z.array(z.string().max(120)).max(5),
});
export const LookupCompanyOutput = z.object({
  candidates: z.array(CompanyCandidate).max(10),
  coverage: z
    .array(
      z.object({ provider: z.string().min(1).max(60), status: z.enum(['searched', 'unsupported', 'unavailable']) }),
    )
    .max(10),
  provenance: ToolProvenance,
});

// ---------------------------------------------------------------------------
// find_company_people: officers/executives from authoritative sources. Absence is explicit (coverage).
// ---------------------------------------------------------------------------
export const FindCompanyPeopleInput = z.strictObject({
  company: z.discriminatedUnion('by', [
    z.strictObject({ by: z.literal('registry_id'), scheme: RegistryScheme, id: z.string().trim().min(1).max(40) }),
    z.strictObject({ by: z.literal('name'), name: z.string().trim().min(2).max(200), country: CountryCode }),
  ]),
  roles: z.array(PersonRole).max(8).optional(),
  includeResigned: z.boolean().default(false),
});
export const PersonRecord = z.object({
  name: z.string().min(1).max(200),
  registeredRole: z.string().min(1).max(120),
  normalizedRole: PersonRole.nullable(),
  appointedOn: IsoDate.nullable(),
  resignedOn: IsoDate.nullable(),
  active: z.boolean(),
  provider: z.string().min(1).max(60),
  providerRecordId: z.string().max(100).nullable(),
  sourceId: SourceId,
});
export const FindCompanyPeopleOutput = z.object({
  people: z.array(PersonRecord).max(100),
  coverage: z.enum(['full', 'partial', 'unsupported_jurisdiction']),
  provenance: ToolProvenance,
});

// ---------------------------------------------------------------------------
// search_knowledge: read the workspace's existing companies, people and claims.
// ---------------------------------------------------------------------------
export const SearchKnowledgeInput = z.strictObject({
  target: z.enum(['companies', 'people', 'claims']),
  text: z.string().trim().min(2).max(200).optional(),
  companyId: CompanyId.optional(),
  attribute: ClaimAttribute.optional(),
  statuses: z.array(ClaimStatus).max(7).optional(),
  limit: z.int().min(1).max(20).default(10),
});
export const SearchKnowledgeOutput = z.object({
  items: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('company'),
          companyId: CompanyId,
          name: z.string(),
          primaryDomain: z.string().nullable(),
          country: CountryCode.nullable(),
        }),
        z.object({
          kind: z.literal('person'),
          personId: PersonId,
          fullName: z.string(),
          roles: z.array(z.object({ companyId: CompanyId, title: z.string() })).max(10),
        }),
        z.object({
          kind: z.literal('claim'),
          claimId: ClaimId,
          statement: z.string(),
          status: ClaimStatus,
          confidence: ConfidenceLevel.nullable(),
          newestSourceDate: Timestamp.nullable(),
        }),
      ]),
    )
    .max(20),
  provenance: ToolProvenance,
});

// ---------------------------------------------------------------------------
// get_source: re-read a saved snapshot (paged). Never re-fetches the live page.
// ---------------------------------------------------------------------------
export const GetSourceInput = z.strictObject({
  sourceId: SourceId,
  offset: Count.default(0),
  maxChars: z.int().min(1000).max(20_000).default(8000),
});
export const GetSourceOutput = z.object({
  sourceId: SourceId,
  finalUrl: HttpUrl,
  title: z.string().max(500).nullable(),
  publishedAt: Timestamp.nullable(),
  retrievedAt: Timestamp,
  contentSha256: Sha256Hex,
  tier: SourceTier,
  flags: z.array(SourceFlag).max(4),
  ...PagedText,
  provenance: ToolProvenance,
});

// ---------------------------------------------------------------------------
// Registry: one place that pairs each tool with its schemas, timeout and MCP annotations.
// "readOnlyHint" means no externally visible effect; the server still records provenance and audit rows.
// ---------------------------------------------------------------------------
interface ToolContract {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly timeoutMs: number;
  readonly openWorld: boolean;
}

export const TOOL_CONTRACTS = {
  web_search: { input: WebSearchInput, output: WebSearchOutput, timeoutMs: 15_000, openWorld: true },
  fetch_page: { input: FetchPageInput, output: FetchPageOutput, timeoutMs: 25_000, openWorld: true },
  lookup_company: { input: LookupCompanyInput, output: LookupCompanyOutput, timeoutMs: 15_000, openWorld: true },
  find_company_people: {
    input: FindCompanyPeopleInput,
    output: FindCompanyPeopleOutput,
    timeoutMs: 15_000,
    openWorld: true,
  },
  search_knowledge: { input: SearchKnowledgeInput, output: SearchKnowledgeOutput, timeoutMs: 5_000, openWorld: false },
  get_source: { input: GetSourceInput, output: GetSourceOutput, timeoutMs: 5_000, openWorld: false },
} as const satisfies Record<ToolName, ToolContract>;

// ---------------------------------------------------------------------------
// Authorisation. The worker mints a short-lived, signed capability token per agent execution;
// external clients authenticate with a workspace API key and get a session scope instead.
// ---------------------------------------------------------------------------
export const CapabilityTokenClaims = z.object({
  iss: z.literal('aoc-worker'),
  aud: z.literal('aoc-mcp'),
  sub: ExecutionId,
  wsp: WorkspaceId,
  run: RunId,
  tsk: TaskId,
  agt: AgentType,
  tools: z.array(ToolName).min(1).max(6),
  maxToolCalls: z.int().positive().max(200),
  iat: z.int().positive(),
  exp: z.int().positive(),
});
export type CapabilityTokenClaims = z.infer<typeof CapabilityTokenClaims>;
