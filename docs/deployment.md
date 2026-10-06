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

- **CI (GitHub Actions) on every push:** actions pinned to commit SHAs (kept current by Dependabot), runner pinned to `ubuntu-24.04`, read-only token. GitHub secret scanning with push protection and Dependabot vulnerability alerts are enabled on the repository.
  Jobs: lint, typecheck, unit tests, build. Then an integration job that starts the
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
| `CAPABILITY_PRIVATE_JWK` | generated Ed25519 private key (JWK; `setup:local` makes one) | `.env.local` | — | yes | — | — |
| `CAPABILITY_PUBLIC_JWK` | its public key (JWK) | `.env.local` | — | — | yes | — |
| `MCP_URL` | the MCP server's `/mcp` endpoint (private network) | `.env.local` | — | yes | — | — |
| `ANTHROPIC_API_KEY` | Anthropic Console (not Claude Code Max) | `.env.local` | — | yes | — | — |
| `EARTHRUNTIME_API_KEY` | Earthruntime | `.env.local` | — | yes | — | — (evals replay recordings) |
| `BAZAARLINK_API_KEY` | BazaarLink (optional, free tier tried first) | `.env.local` | — | yes | — | — |
| `TAVILY_API_KEY` | Tavily (free plan: 1,000 credits/month) | `.env.local` | — | — | yes | — |
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

```bash
pnpm install
pnpm db:start        # local Supabase: Postgres, Auth, API gateway, Realtime (migrations applied)
pnpm setup:local     # random local password for aoc_service + git-ignored .env.local files
pnpm dev             # web on :3000, worker health on :8081, MCP server health on :8082
```

| Command | Does |
|---|---|
| `pnpm check` | format check, lint, typecheck, unit tests, build (what CI's first job runs) |
| `pnpm db:test` | pgTAP suite: roles, RLS, signup trigger |
| `pnpm test:integration` | database integration tests, connected as a throwaway role identical to `aoc_service` |
| `pnpm db:reset` | recreate the local database and re-apply migrations |
| `pnpm db:types` / `pnpm --filter @aoc/web gen:types` | regenerate Kysely / Supabase types from the local schema |

- The local stack uses its own ports (API 55321, Postgres 55322), so it never collides with another project's
  default 543xx stack. Studio, Storage, local mail, edge functions and analytics are disabled in `supabase/config.toml`.
- The Supabase CLI is pinned to 2.109.1 because its container images were already on the development machine.
  `supabase/.temp/postgres-version` (git-ignored, local only) pins the Postgres image that is on disk; CI pulls the
  CLI's default image.
- `pnpm setup:local` never prints a secret. It can be rerun at any time (it rotates the local password).
- Opening the app from another computer (e.g. the host of a VM): use the machine's network address, not `localhost`.
  Next.js blocks dev-server resources from origins other than `localhost` unless they are listed in
  `allowedDevOrigins`, which `next.config.ts` reads from `ALLOWED_DEV_ORIGINS`. `pnpm setup:local` writes this
  machine's LAN addresses there and prints the URLs; restart `pnpm dev` after running it. Dev only; production is
  unaffected.
- The sign-in / create-account switch is a plain link (`/sign-in?mode=sign-up`), so both forms work even if
  JavaScript fails to load.
- Credentials that aren't configured stay as placeholders. Everything that doesn't need them keeps working.

## Production database role (one-time)

Migrations create `aoc_service` without a password. Before the worker or MCP server first connects to the cloud
database, set one out of band:
1. Generate a strong password locally.
2. Run `alter role aoc_service password '<generated>';` in the Supabase SQL editor.
3. Store the password only in the Railway and Vercel `DATABASE_URL` variables, connecting as `aoc_service.<project-ref>`
   through the pooler.

Whether Supabase's pooler accepts the custom role is the open validation item from
[ADR-0005](adr/0005-workspace-isolation.md); it is checked at the first deploy.
