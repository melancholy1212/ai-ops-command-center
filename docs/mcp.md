# MCP server contract

The MCP server is the capability layer between agents and the outside world. Contracts:
[`tools.ts`](../packages/contracts/src/tools.ts).

## Why MCP here

1. **One enforcement point.** Egress policy, provider keys, tool permissions, rate limits, snapshot capture and audit
   all live in one service, whatever calls it.
2. **Agents are decoupled from providers.** Replacing the search provider changes an adapter, not an agent.
3. **It stands alone.** Any MCP client (Claude Code, MCP Inspector, another agent platform) can use the same research
   tools with the same guarantees: provenance-bound fetching, saved snapshots, audited calls.
4. **Independently deployable and testable.**

## What is not in MCP

Task creation or scheduling, workflow transitions, approval decisions, claim or finding writes, and arbitrary database
writes. Those are domain commands in `packages/core`, reachable only by the application ([ADR-0003](adr/0003-mcp-capability-layer.md)).
The server's only writes are bookkeeping it owns: discovered URLs, snapshots, provider cache, rate-limit counters,
tool-call audit rows.

## Transports and authentication

| Caller | Transport | Credential | Scope |
|---|---|---|---|
| Worker (agent executions) | Streamable HTTP, stateless, Railway private network | Capability token: EdDSA-signed JWT minted per execution (`CapabilityTokenClaims`): workspace, run, task, execution, agent, allowed tools, max tool calls, expiry ≤ 30 min | The run |
| External MCP client | Streamable HTTP (public endpoint, after the MVP) or stdio (local) | Workspace API key (`aoc_...`), stored as a SHA-256 hash, revocable, per-key rate limits | A client session: created on first call, closed after 24 h idle |

The worker holds the signing key; the MCP server holds only the verification key, so it can't mint tokens.

## Request pipeline

Every call, in this order:

1. **Authenticate:** verify the token signature, issuer, audience and expiry, or look up the API key hash.
2. **Authorise:** the tool must be in the token's `tools` (the role allowlist) or the key's scopes →
   `TOOL_NOT_PERMITTED`. Execution tool-call count below `maxToolCalls` → `BUDGET_EXCEEDED`.
3. **Validate** input with the tool's Zod schema (strict: unknown keys rejected) → `INVALID_ARGUMENT`.
4. **Rate limit:** per workspace per tool, per provider, per fetched host → `RATE_LIMITED` with `retryAfterMs`.
5. **Execute** with the tool's timeout, inside a transaction scoped to the workspace (row-level security applies to
   the server too, [security.md](security.md)).
6. **Validate output** with the output schema. A mismatch is a server bug → `INTERNAL`, never passed through.
7. **Audit:** one `tool_calls` row: tool, argument hash and arguments, status, error code, provider, cache hit,
   latency, upstream latency, cost, created snapshots, scope ids.
8. **Respond:** `structuredContent` (the typed output) plus a short text rendering for clients that ignore structured content.

## Errors

- **Protocol errors** (JSON-RPC): unknown tool, malformed request.
- **Tool errors:** a result with `isError: true` whose text content is a JSON `ToolError`: `code`, `message`,
  `retryable`, `retryAfterMs`, `toolCallId`. (Not in `structuredContent`: MCP clients validate structured content
  against the tool's output schema even on errors, so it can't carry a different shape.) Messages are safe for the model to read: no stack traces, secrets,
  internal hostnames or provider response bodies. Details go to logs.

| Code | Retryable | Meaning |
|---|---|---|
| `INVALID_ARGUMENT` | no | Input failed the schema |
| `UNAUTHENTICATED` / `TOOL_NOT_PERMITTED` | no | Bad credential / tool not in scope |
| `URL_NOT_PERMITTED` | no | URL has no origin in this scope |
| `URL_BLOCKED` / `ROBOTS_DISALLOWED` | no | Egress policy / robots.txt |
| `RATE_LIMITED` | yes | With `retryAfterMs` |
| `QUOTA_EXCEEDED` / `BUDGET_EXCEEDED` | no | Provider quota / execution tool budget |
| `PROVIDER_UNAVAILABLE` / `UPSTREAM_ERROR` / `TIMEOUT` | yes | Provider trouble |
| `CONTENT_TOO_LARGE` / `UNSUPPORTED_CONTENT_TYPE` | no | Fetch limits |
| `NOT_FOUND` / `UNSUPPORTED_JURISDICTION` | no | Nothing there / no provider for that country |
| `INTERNAL` | yes (once) | Server bug |

## Implementation status

Phase 3 implements the HTTP endpoint with capability tokens and three tools: `web_search` (Tavily),
`fetch_page` and `get_source`. `search_knowledge` arrives with the knowledge tables in Phase 4, and `lookup_company`
and `find_company_people` with the registry providers in Phase 5; until then the server doesn't list them, even
if a token grants them. Workspace API keys for external clients come later, so the stdio entry point currently
advertises no tools. Each tool call's cost (Tavily: 1 credit, charged at the $0.008 pay-as-you-go rate) and the call
itself are added to the run's spend in the same transaction as its audit row.

`fetch_page` serves a snapshot this run already saved from the same discovered URL (within 24 h) instead of
fetching again, so paging through a long page with `offset` doesn't refetch it or create a second snapshot.

## Tools

| Tool | Capability | Side effects (bookkeeping) | Timeout | Default limits (per workspace) |
|---|---|---|---|---|
| `web_search` | Search the web or news, with recency and domain filters | Result URLs recorded as `search_result` origins | 15 s | 30/min |
| `fetch_page` | Fetch an authorised URL, extract text, return a page of it | Snapshot saved; page links recorded as `page_link` origins | 25 s | 60/min, 1/s per host |
| `lookup_company` | Resolve a company by name, domain or registry id to registry-backed records | Each record saved as a snapshot; websites recorded as `provider_record` origins | 15 s | 30/min |
| `find_company_people` | Officers and executives from authoritative registries | Each record saved as a snapshot | 15 s | 30/min |
| `search_knowledge` | Search the workspace's companies, people and claims | none | 5 s | 120/min |
| `get_source` | Re-read a saved snapshot, paged | none | 5 s | 120/min |

Annotations: all six are `readOnlyHint: true` (no externally visible effect), `destructiveHint: false`,
`idempotentHint: true`; `openWorldHint` is true for the four external tools.

### `web_search`
Input: `query` (3–400 chars), `mode` (`general` | `news`), `recencyDays`, `includeDomains`, `excludeDomains`,
`maxResults` (1–10). Output: results with URL, title, snippet, published date, rank and the `discoveredUrlId` that
now authorises fetching it; provenance (tool call id, provider, retrieval time, cached). Provider: Tavily first, behind
`SearchProvider`.

### `fetch_page`
Input: `url`, `offset`, `maxChars` (1,000–20,000). Output: `sourceId`, final and canonical URL, title, published date,
retrieval time, content hash, tier, flags, the requested text window with `totalChars` and `hasMore`, up to 100 links
(each with its new `discoveredUrlId`), provenance. Errors: `URL_NOT_PERMITTED`, `URL_BLOCKED`, `ROBOTS_DISALLOWED`,
`CONTENT_TOO_LARGE`, `UNSUPPORTED_CONTENT_TYPE`, `TIMEOUT`.

### `lookup_company`
Input: `query` as one of `{by: 'name', name, country?}`, `{by: 'domain', domain}`,
`{by: 'registry_id', scheme, id}`; `maxCandidates`. Output: candidates with provider, record id, legal and other
names, country, registry ids, status, incorporation date, website, address, `sourceId`, and a **code-computed**
`matchScore` with reasons; per-provider coverage (`searched` / `unsupported` / `unavailable`). Providers: UK Companies
House, France's Recherche d'entreprises, GLEIF, Wikidata, behind `CompanyDataProvider`.

### `find_company_people`
Input: company by registry id or by name + country; roles; `includeResigned`. Output: people with registered role,
normalised role, appointment and resignation dates, active flag, provider, `sourceId`; `coverage`
(`full` | `partial` | `unsupported_jurisdiction`). "No registry for this country" is an explicit result, not an
empty list. Providers: Companies House officers, Recherche d'entreprises executives, behind `PeopleDataProvider`.

### `search_knowledge`
Input: `target` (companies | people | claims), text, company id, attribute, statuses, limit. Output: typed items;
claims come with their code-rendered statement, status, confidence and newest source date. Scoped to the workspace
by row-level security.

### `get_source`
Input: `sourceId`, `offset`, `maxChars`. Output: the saved snapshot window and its metadata. Never re-fetches.

## Standalone use

Local, stdio: `pnpm --filter mcp-server start:stdio` with `AOC_API_KEY` set. Works with MCP Inspector and any
stdio MCP client. Remote: `POST /mcp` with `Authorization: Bearer <workspace API key>`. External sessions follow the
same provenance rule: they can fetch only URLs their own searches, fetched pages or provider records produced.

## Testing

- Each tool against recorded provider responses (success, empty, rate-limited, malformed).
- Contract tests through an in-memory MCP client: schemas advertised, errors shaped as documented.
- Egress test matrix: private IPs, IPv6 edge cases, DNS rebinding, redirect to a private address, oversized and
  slow responses, wrong content types.
- Authorisation tests: expired or forged tokens, tools outside the allowlist, over-budget executions, revoked keys.
