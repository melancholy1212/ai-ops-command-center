# Security and threat model

## Assets

Tenant data (runs, claims, research on real people); provider and model credentials; LLM and data-provider spend;
approval integrity; availability of runs in progress.

## Actors

Authenticated users (possibly malicious); other tenants; authors of malicious web pages; external MCP clients;
compromised dependencies; anyone on the internet.

## Trust boundaries

1. Browser → web app (untrusted input).
2. Web app → Postgres (as the user under RLS; commands through the backend role).
3. Worker → Postgres (backend role, scoped per transaction).
4. Worker → MCP server (capability token).
5. MCP server → internet (untrusted content, SSRF surface).
6. Worker → LLM providers (our prompts out, untrusted model output in).
7. External MCP clients → MCP server (API keys).

## Threats and controls

| # | Threat | Control | Enforced in | Verified by |
|---|---|---|---|---|
| 1 | One tenant reads or writes another's data | Every tenant row has `workspace_id`; RLS for users (membership) and for the backend role (transaction-local `app.workspace_id`); only two audited `SECURITY DEFINER` functions cross tenants (claim, reap) and return minimal data | Postgres | pgTAP: user A vs B; backend scoped to W vs W′ |
| 2 | Model output becomes a privileged operation | Model output is a proposal: schema-validated, then mapped only to allowed domain actions (propose claims, findings, drafts). No model-controlled SQL, task creation, state transition, approval, URL outside provenance, or send | worker, core | unit tests on handlers; injection eval cases |
| 3 | Prompt injection from web pages | Read-only tools for web-reading roles; per-execution capability tokens; no secrets in context; writers never see page text; provenance-bound fetching; injection heuristics lower confidence; human approval before anything outward ([provenance.md](provenance.md#prompt-injection)) | worker, MCP | `prompt-injection-page` eval |
| 4 | SSRF via fetch | Egress policy: scheme/port allowlist, IP blocklist incl. metadata ranges, pinned DNS, per-hop redirect validation, size/time/content-type limits | MCP fetcher | egress test matrix |
| 5 | Exfiltration through URLs | A model can't compose a fetchable URL; only URLs with an origin in scope | MCP | URL provenance tests |
| 6 | Secret leakage | Secrets per service (model keys only in the worker, provider keys only in the MCP server); env validated at boot; log redaction; only the Supabase publishable key reaches the browser; secret scanning in CI; secrets never pasted into chat or committed | all | CI secret scan; env tests |
| 7 | Service-role misuse | The Supabase service-role/secret key is used only by migration and admin tooling, never by a running service | deployment | config review; env schema forbids it in services |
| 8 | Runaway cost | Per-run budgets checked before every claim and inside loops; per-workspace monthly cap; turn and tool-call caps; per-user run-creation limit; live runs only for allowlisted accounts on the public deployment | worker, core | `budget-exhaustion` eval |
| 9 | Approval tampering / time-of-check-time-of-use | Frozen snapshot + hash; decision must quote the hash; triggers forbid updating snapshots and approved versions; hash re-checked before use, invalidation on change | core, Postgres | state-machine tests |
| 10 | Forged or replayed capability tokens | EdDSA signatures, issuer/audience/expiry checks, bound to one execution, ≤ 30 min, verify-only key on the MCP server | MCP | auth tests |
| 11 | External MCP client abuse | Hashed, revocable, scoped API keys; per-key rate limits; session-scoped provenance; full audit | MCP | auth + rate-limit tests |
| 12 | Denial of service / expensive requests | Rate limits in Postgres (per user, workspace, tool, provider, host); request size limits; timeouts everywhere | web, MCP | load smoke test |
| 13 | Poisoned facts from a lying page | Independence and authority policies; syndication detection; contested state; visible provenance | verification | conflict / syndication evals |
| 14 | Personal-data misuse (GDPR) | Business-role data from public sources only; provenance on every personal detail; no contact guessing; retention; delete-person cascade; nothing sent automatically | domain, Postgres | tests on deletion cascade |
| 15 | Error leakage | Clients get typed error codes and safe messages; stack traces and provider bodies only in logs | all | API tests |
| 16 | Tampering with the audit trail | `audit_logs` and `run_events` are append-only: no UPDATE/DELETE grants | Postgres | pgTAP |
| 17 | Supply chain | Lockfile; pinned versions; install scripts allowed only for listed packages; automated dependency updates; CI with least-privilege tokens | repo, CI | CI config |

## Database roles

| Role | Used by | Can |
|---|---|---|
| `anon` | nobody | nothing |
| `authenticated` | the browser and server components, as the signed-in user | read their workspaces' rows through RLS; no direct writes to workflow, evidence or telemetry tables |
| `app_backend` | worker, MCP server, web commands | read and write within the workspace set in the transaction; insert-only on append-only tables; call `claim_next_task` and `reap_expired_leases` |
| `service_role` | migrations, admin scripts | everything; never configured in a running service |

RLS is not a substitute for privileges: every role gets explicit `GRANT`s for exactly what it needs, and new tables
start with nothing granted.

## Backend authorisation

Domain commands run in `packages/core`:
1. Validate input with Zod.
2. Resolve the user from the Supabase session.
3. Check workspace membership and the command's minimum role (`COMMAND_MIN_ROLE`).
4. Open a transaction as `app_backend` with `app.workspace_id` set to that workspace.
5. Perform the transition.
6. Write `audit_logs` for security-relevant actions: approvals, membership changes, API keys, run start and cancel, exports, deletions.

## Residual risks

- A single-source lie on an otherwise credible page can still reach `probable`. It is shown as such, with its source.
- Heuristic injection detection will miss novel phrasings. The structural controls don't depend on it.
- On the Supabase free plan there are no managed backups; see [deployment.md](deployment.md).
