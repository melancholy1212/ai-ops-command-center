# Workflow specification: prospect research

The workflow as code: [`TASK_DEFINITIONS`](../packages/contracts/src/workflow.ts). As data: one row per task in
`tasks`, one row per edge in `task_dependencies`. Reading either tells you exactly what will run, in what order,
and why.

```
plan_run ─► approve_plan ─► discover_companies
                               │ expansion (code): top N candidates → one chain per company
                               ▼
         profile_company ─► find_people ─► verify_entity (r1) ─► [gap_fill ─► verify_entity (r2)]
                               │ soft join: every company's last verify is terminal
                               ▼
         rank_and_analyze ─► draft_outreach × K ─► approve_outreach ─► compile_report ─► done
```

## Workflow version 1 (implemented, Phase 4)

Runs record their `workflow_version`. Version 1 is the part of the graph above that exists today:

```
plan_run ─► approve_plan ─► discover_companies ─► verify_entity × top N ─► compile_report
                                                  (soft join: the report waits for every verification)
```

- `plan_run`: the planner proposes; code normalises (region table, funding window clamped to today, limits) and
  records every default as an assumption. Outreach is disabled in version 1, and the plan says so.
- `discover_companies`: the Research agent's claims are grounded against saved snapshots and persisted in the
  completion transaction; the top N candidates by a deterministic pre-score get a verification task.
- `verify_entity`: the verifier judges grounded quotes; policy, criteria, conflicts, confidence and coverage gaps are
  code. Gaps are recorded as unavailable (there is no gap-fill yet).
- `compile_report`: code only. Included companies passed verification and fit the brief; each gets a score finding
  (score@1) citing its claims. Everything else is listed as excluded with a reason and the claims behind it.

### Targeted search

The plan carries `newsOutlets`: funding-news sites that cover the brief's countries, chosen by code from a static
table (`packages/core/src/workflow/outlets.ts`, regional outlets before pan-European ones, at most 8). They are
shown on the approval card. Discovery is told to search them first, passing them as `includeDomains`, and to search
more broadly only after that. In live runs, searches limited to a funding-news site found real rounds; open searches
mostly returned roundups and listicles. Outlets are suggestions to the search, not an allowlist: fetching still
follows URL provenance and the egress policy.

## Task catalogue

| Task | Created | Kind | Agent · route | Consumes | Produces | Attempts | Pauses | Parallel |
|---|---|---|---|---|---|---|---|---|
| `plan_run` | run start | structured call | planner · planning | objective, project defaults, rejection feedback | `ResearchBrief` on the run | 3 | — | — |
| `approve_plan` | run start | human gate | — | brief, budget, cost estimate | plan approval | 1 | yes | — |
| `discover_companies` | run start | agent loop | research · agent_loop | brief criteria | company rows, discovery claims + evidence | 2 | — | — |
| `profile_company` | expansion | agent loop | company_intelligence · agent_loop | company identity, discovery claims | company claims, registry identifiers | 2 | — | per company |
| `find_people` | expansion | agent loop | people_discovery · agent_loop | verified identity (domain, registry id), roles | people rows, role claims | 2 | — | per company |
| `verify_entity` r1/r2 | expansion | structured calls | verifier · judge | the company's proposed claims | statuses, confidence, conflicts, gaps | 3 | — | per company |
| `gap_fill` | expansion (conditional) | agent loop | research · agent_loop | open gaps + known identifiers | new proposed claims | 1 | — | per company |
| `rank_and_analyze` | expansion | code + structured call | analyst · analysis | verified/probable claims, criteria weights | score findings (code), analysis findings (model) | 2 | — | — |
| `draft_outreach` | expansion | structured call | outreach_writer · writing | verified claims for the company and people, sender profile | outreach draft artifacts | 2 | — | per company |
| `approve_outreach` | expansion | human gate | — | drafts | one approval per draft | 1 | yes | — |
| `compile_report` | expansion | code | — | findings, claims, gaps, approved drafts | prospect report artifact + exports | 3 | — | — |

"Agent loop" = a bounded tool-using loop ([agents.md](agents.md)). "Structured call" = one model call with a
schema-constrained output inside a code step (the verifier makes one judge call per batch of quotes).

## Expansion rules (code, not models)

| When this succeeds | Code creates | Dependencies |
|---|---|---|
| `discover_companies` | For the top `maxCompanies` candidates (ranked by a deterministic pre-score over discovery claims: criteria matches, funding recency, evidence tier): `profile_company`, `find_people`, `verify_entity r1`. Plus one `rank_and_analyze`. | profile → people (hard); profile → verify r1 (hard: no profile, no verification, company excluded); people → verify r1 (soft: verify company claims even if people discovery failed); verify r1 → rank (soft) |
| `verify_entity r1` with open required gaps and budget headroom | `gap_fill`, `verify_entity r2` | verify r1 → gap_fill (hard); gap_fill → verify r2 (soft); verify r2 → rank (soft, added to the still-blocked rank task) |
| `verify_entity r2` | nothing; remaining gaps become `unavailable` | — |
| `rank_and_analyze` | If outreach is enabled: `draft_outreach` for the top K companies that have ≥ 1 verified decision maker, one `approve_outreach`, one `compile_report`. Otherwise only `compile_report`. | rank → drafts (hard); drafts → approve (soft); approve → report (hard); rank → report (hard) |

The planner decides *what* to research (criteria, roles, whether outreach is wanted). Expansion rules decide the
graph's shape. No model ever creates a task.

## What each step guarantees

- **plan_run**: the planner proposes criteria; code normalises them (e.g. "Europe" → an explicit country list from a
  static region table), clamps limits to project maximums, computes a cost estimate from per-task averages, and
  records every default it applied as an `Assumption`.
- **discover_companies**: candidates must come with evidence (a saved source and a quote). Candidates without grounded
  evidence are dropped before expansion.
- **profile_company / find_people / gap_fill**: output is `ProposedClaim[]`. The domain grounds, deduplicates and
  persists them; agents never write rows.
- **verify_entity**: see [provenance.md](provenance.md#verification). Missing required attributes
  (`REQUIRED_COMPANY_ATTRIBUTES`, `REQUIRED_PERSON_ATTRIBUTES`) become `research_gaps`.
- **rank_and_analyze**: the score is code over verified/probable claims with weights from the project (funding recency,
  stage fit, geography fit, hiring signal, data completeness). The analyst writes labelled findings that cite claims;
  code rejects findings citing anything else.
- **draft_outreach**: the writer sees rendered claim statements only, never page text. Code checks each personalisation
  point cites verified claims of that company/person. One redraft with the validation errors, then the draft is dropped.
- **approve_outreach**: one approval per draft; the gate completes when all are decided. Rejected drafts are excluded
  with their reason.
- **compile_report**: deterministic. Re-validates every approval hash before including a draft
  ([state-machines.md](state-machines.md#approval)).

## Failure policy

| Task fails permanently | Effect |
|---|---|
| `plan_run`, `discover_companies`, `compile_report` | Run fails with the task's failure code |
| `profile_company` | That company's chain is skipped; the company appears in the report as excluded with the reason |
| `find_people` | Company claims are still verified; people fields become gaps |
| `verify_entity` | Company excluded with reason |
| `gap_fill` | Round 2 verifies what exists; gaps become `unavailable` |
| `rank_and_analyze` | Run fails (nothing to report) |
| `draft_outreach` | That draft is missing; the gate proceeds with the rest |

## Budgets and concurrency

- Before claiming an LLM task, the scheduler checks remaining budget against the task type's estimated cost. If it
  would not fit, the run pauses with a `budget_extension` approval instead of starting work it can't finish.
- Spend is summed from `llm_calls` and `tool_calls`, including failed attempts.
- Thresholds at 50 %, 80 % and 100 % emit `budget.threshold_crossed` events.
- Limits: worker concurrency (default 4), per-run concurrency (default 4), per-provider concurrency (config), per-host
  fetch politeness (1 request/s).

## End conditions

The run completes when `compile_report` succeeds. It fails when a fatal task fails. It is cancelled only by a user.
A run with zero qualifying companies after discovery completes with an empty report that says so, rather than failing.
