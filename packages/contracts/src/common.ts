/**
 * Shared primitives for the domain contracts: branded identifiers, value formats,
 * actors, failures, and the taxonomies used by more than one contract.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Identifiers. Every id is a UUID with a brand, so a TaskId cannot be passed
// where a RunId is expected.
// ---------------------------------------------------------------------------
export const WorkspaceId = z.uuid().brand<'WorkspaceId'>();
export type WorkspaceId = z.infer<typeof WorkspaceId>;
export const ProjectId = z.uuid().brand<'ProjectId'>();
export type ProjectId = z.infer<typeof ProjectId>;
export const UserId = z.uuid().brand<'UserId'>();
export type UserId = z.infer<typeof UserId>;
export const RunId = z.uuid().brand<'RunId'>();
export type RunId = z.infer<typeof RunId>;
export const TaskId = z.uuid().brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskId>;
export const ExecutionId = z.uuid().brand<'ExecutionId'>();
export type ExecutionId = z.infer<typeof ExecutionId>;
export const LlmCallId = z.uuid().brand<'LlmCallId'>();
export type LlmCallId = z.infer<typeof LlmCallId>;
export const ToolCallId = z.uuid().brand<'ToolCallId'>();
export type ToolCallId = z.infer<typeof ToolCallId>;
export const McpSessionId = z.uuid().brand<'McpSessionId'>();
export type McpSessionId = z.infer<typeof McpSessionId>;
export const ApiKeyId = z.uuid().brand<'ApiKeyId'>();
export type ApiKeyId = z.infer<typeof ApiKeyId>;
export const DiscoveredUrlId = z.uuid().brand<'DiscoveredUrlId'>();
export type DiscoveredUrlId = z.infer<typeof DiscoveredUrlId>;
export const SourceId = z.uuid().brand<'SourceId'>();
export type SourceId = z.infer<typeof SourceId>;
export const EvidenceId = z.uuid().brand<'EvidenceId'>();
export type EvidenceId = z.infer<typeof EvidenceId>;
export const ClaimId = z.uuid().brand<'ClaimId'>();
export type ClaimId = z.infer<typeof ClaimId>;
export const GapId = z.uuid().brand<'GapId'>();
export type GapId = z.infer<typeof GapId>;
export const CompanyId = z.uuid().brand<'CompanyId'>();
export type CompanyId = z.infer<typeof CompanyId>;
export const PersonId = z.uuid().brand<'PersonId'>();
export type PersonId = z.infer<typeof PersonId>;
export const ApprovalId = z.uuid().brand<'ApprovalId'>();
export type ApprovalId = z.infer<typeof ApprovalId>;
export const FindingId = z.uuid().brand<'FindingId'>();
export type FindingId = z.infer<typeof FindingId>;
export const ArtifactId = z.uuid().brand<'ArtifactId'>();
export type ArtifactId = z.infer<typeof ArtifactId>;

// ---------------------------------------------------------------------------
// Value formats
// ---------------------------------------------------------------------------
export const Timestamp = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;
export const IsoDate = z.iso.date();
export type IsoDate = z.infer<typeof IsoDate>;
export const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase hex SHA-256 digest');
export type Sha256Hex = z.infer<typeof Sha256Hex>;
export const HttpUrl = z.url({ protocol: /^https?$/ }).max(2048);
export type HttpUrl = z.infer<typeof HttpUrl>;
export const Hostname = z
  .string()
  .max(253)
  .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/, 'Expected a lowercase hostname');
export const CountryCode = z.string().regex(/^[A-Z]{2}$/, 'Expected an ISO 3166-1 alpha-2 code');
export type CountryCode = z.infer<typeof CountryCode>;
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 code');
/** Money is integer micro-US-dollars (1 USD = 1_000_000), so sums stay exact. */
export const UsdMicros = z.int().nonnegative();
export const Count = z.int().nonnegative();
/** Any JSON value. Only used where the shape is validated by a narrower schema elsewhere. */
export const JsonValue = z.json();
/** Small key/value counters shown in the UI (e.g. `{ claimsProposed: 12 }`). */
export const SmallSummary = z.record(z.string().max(60), z.union([z.number(), z.string().max(200), z.boolean()]));

// ---------------------------------------------------------------------------
// Who caused something
// ---------------------------------------------------------------------------
export const WorkspaceRole = z.enum(['owner', 'admin', 'member', 'viewer']);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

export const Actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: UserId }),
  z.object({ kind: z.literal('worker'), workerId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('mcp_client'), apiKeyId: ApiKeyId }),
  z.object({ kind: z.literal('system') }),
]);
export type Actor = z.infer<typeof Actor>;

// ---------------------------------------------------------------------------
// Failures. The class decides retry behaviour; the code says what happened.
// ---------------------------------------------------------------------------
export const FailureClass = z.enum(['transient', 'permanent', 'policy']);
export type FailureClass = z.infer<typeof FailureClass>;

export const FailureCode = z.enum([
  'LEASE_EXPIRED', // the worker holding the task stopped heartbeating
  'TASK_TIMEOUT', // the handler ran past the worker's time limit for one attempt
  'PROVIDER_RATE_LIMITED', // an LLM or data provider throttled us after in-call retries
  'PROVIDER_UNAVAILABLE', // 5xx, network error or timeout after in-call retries
  'LLM_OUTPUT_INVALID', // output still failed its schema after repair turns
  'LLM_REFUSAL', // the model declined the request
  'LLM_TRUNCATED', // the model hit its output token limit
  'AGENT_LIMIT_REACHED', // turn or tool-call cap reached without a result
  'TOOL_FAILED', // a tool error the agent could not work around
  'OUTPUT_REJECTED', // domain validation refused the output (e.g. outreach cites an unverified claim)
  'BUDGET_EXHAUSTED', // continuing would exceed the run budget
  'APPROVAL_REJECTED', // a human rejected the gate
  'DEPENDENCY_FAILED', // a hard dependency did not succeed
  'CANCELLED', // the run was cancelled
  'INTERNAL_ERROR', // a bug; retried a limited number of times
]);
export type FailureCode = z.infer<typeof FailureCode>;

export const FAILURE_CLASS = {
  LEASE_EXPIRED: 'transient',
  TASK_TIMEOUT: 'transient',
  PROVIDER_RATE_LIMITED: 'transient',
  PROVIDER_UNAVAILABLE: 'transient',
  LLM_OUTPUT_INVALID: 'permanent',
  LLM_REFUSAL: 'permanent',
  LLM_TRUNCATED: 'permanent',
  AGENT_LIMIT_REACHED: 'permanent',
  TOOL_FAILED: 'permanent',
  OUTPUT_REJECTED: 'permanent',
  BUDGET_EXHAUSTED: 'policy',
  APPROVAL_REJECTED: 'policy',
  DEPENDENCY_FAILED: 'policy',
  CANCELLED: 'policy',
  INTERNAL_ERROR: 'transient',
} as const satisfies Record<FailureCode, FailureClass>;

export const Failure = z.object({
  code: FailureCode,
  class: FailureClass,
  message: z.string().min(1).max(2000),
  retryable: z.boolean(),
  occurredAt: Timestamp,
  detail: z.record(z.string(), JsonValue).optional(),
});
export type Failure = z.infer<typeof Failure>;

// ---------------------------------------------------------------------------
// Taxonomies shared across contracts
// ---------------------------------------------------------------------------
/** Tool loops: research, company_intelligence, people_discovery. The rest are single structured calls. */
export const AgentType = z.enum([
  'planner',
  'research',
  'company_intelligence',
  'people_discovery',
  'verifier',
  'analyst',
  'outreach_writer',
]);
export type AgentType = z.infer<typeof AgentType>;

/** What a model call needs; the router maps each class to a provider + model in config. */
export const RouteClass = z.enum(['planning', 'agent_loop', 'extraction', 'judge', 'analysis', 'writing']);
export type RouteClass = z.infer<typeof RouteClass>;

export const FundingStage = z.enum([
  'pre_seed',
  'seed',
  'series_a',
  'series_b',
  'series_c',
  'series_d_plus',
  'growth',
  'grant',
  'debt',
  'undisclosed',
]);
export type FundingStage = z.infer<typeof FundingStage>;

export const PersonRole = z.enum([
  'founder',
  'ceo',
  'cto',
  'ciso',
  'coo',
  'cfo',
  'cpo',
  'head_of_engineering',
  'head_of_security',
  'head_of_sales',
  'head_of_product',
  'other_executive',
]);
export type PersonRole = z.infer<typeof PersonRole>;

export const RegistryScheme = z.enum(['gb_companies_house', 'fr_siren', 'lei', 'wikidata']);
export type RegistryScheme = z.infer<typeof RegistryScheme>;
