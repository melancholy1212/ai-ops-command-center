# Deployment

## Environments

| Environment | Web | Worker + MCP server | Database |
|---|---|---|---|
| Local | `next dev` | Node processes started by `pnpm dev` (Turborepo) | Supabase CLI local stack |
| Production | Vercel | Railway (two services, private networking) | Supabase cloud project |

A staging environment is added when there are real users. Until then, CI plus local integration tests cover it.

## Topology and regions

- **Supabase:** EU region (Frankfurt). The flagship workflow handles data about European companies and people.
- **Railway:** EU region, next to the database. The worker makes many small database round trips.
- **Vercel:** functions pinned to Frankfurt.
- The MCP server gets a public endpoint only when external clients are enabled; the worker reaches it over Railway's
  private network.

## Free-tier constraints (decision: stay on Supabase free for now, [ADR-0010](adr/0010-supabase-free-tier.md))

| Limit | Consequence | Mitigation |
|---|---|---|
| Projects pause after a week of inactivity | The demo can be offline when someone visits | Documented; unpausing is a dashboard action; revisit before sharing the demo widely |
| No managed backups | Data loss risk | Nightly logical dump via GitHub Actions, **encrypted** before upload (Actions artifacts on a public repo are downloadable by others) |
| 500 MB database | Limits stored runs | Snapshot references instead of copies in conversation logs; retention pruning; size tracked |
| Limited number of active free projects | The org already has two | Checked when the project is created; options then are pausing one or a separate org |

Railway: about $5–10 per month for two small always-on services. Vercel Hobby: free.

## CI/CD

- **CI (GitHub Actions) on every push:** lint, typecheck, unit tests, build. Then an integration job that starts the
  Supabase local stack (database and auth only), applies all migrations, runs pgTAP RLS tests and database integration
  tests. From Phase 3, also `replay-all` evals.
- **Deploy:** Vercel and Railway deploy from `main` through their Git integrations, gated on CI where the platform
  supports it. Migrations are applied by a CI job with the database password as a CI secret. Because migrations
  are expand/contract, the web app, worker and MCP server never depend on deploy order.
- **Runtime:**
  - Railway health checks hit `/healthz`; readiness includes database connectivity.
  - On SIGTERM, the worker stops claiming, finishes or releases its leases, and exits.

## Secrets

Never pasted into chat, never committed. `.env.example` files list every variable with placeholders.

| Variable | Provider | Local | Vercel | Railway worker | Railway MCP | CI |
|---|---|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase | `.env.local` | yes | — | — | — |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase | `.env.local` | yes | — | — | — |
| `DATABASE_URL` (as `app_backend`) | Supabase | `.env.local` | yes (commands) | yes | yes | — |
| `SUPABASE_DB_PASSWORD` | Supabase | — | — | — | — | secret (migrations) |
| `MCP_CAPABILITY_SIGNING_KEY` | generated Ed25519 private key | `.env.local` | — | yes | — | — |
| `MCP_CAPABILITY_VERIFY_KEY` | its public key | `.env.local` | — | — | yes | — |
| `ANTHROPIC_API_KEY` | Anthropic Console (not Claude Code Max) | `.env.local` | — | yes | — | — |
| `EARTHRUNTIME_API_KEY` | Earthruntime | `.env.local` | — | yes | — | — |
| `TAVILY_API_KEY` | Tavily | `.env.local` | — | — | yes | — |
| `COMPANIES_HOUSE_API_KEY` | UK Companies House | `.env.local` | — | — | yes | — |

The Supabase service-role key is not in this table on purpose: no running service uses it.

## CLI authentication

The person running the project authenticates each CLI in their own terminal. Tokens stay in the CLIs' own config,
not in chat or in the repository:

- `gh auth login` (GitHub: repository, CI secrets)
- `npx supabase login` (Supabase: project, migrations)
- `railway login` (Railway: services, variables)
- `npx vercel login` (Vercel: project, variables)

## Local development

- `pnpm install`, copy `.env.example` files to `.env.local`, then `pnpm db:start` and `pnpm dev`.
- The Supabase CLI is pinned to a version whose container images are already on the development machine, and
  `db:start` excludes services the project doesn't use (Studio, Storage, edge runtime, logging). The machine has
  about 5 GB of free disk; one CLI upgrade can pull several GB of images.
- Credentials that aren't configured stay as placeholders. Everything that doesn't need them keeps working:
  replay evals, unit tests, the UI against local data.
