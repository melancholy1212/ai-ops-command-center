# UI: the control room

A premium dark operations console for a real system, not a chat window and not a sci-fi dashboard.

## The honesty rule

Every visual element maps to a persisted field. Nothing animates, counts or progresses unless the database says so.

- Progress is task counts (e.g. 14 of 31 tasks done), never a timed bar.
- A task node shows "running" only while its lease is live (`lease_expires_at > now`).
- Empty states say what is missing and why ("No sources yet: discovery hasn't started").
- When live updates drop, the UI says "Live updates paused, reconnecting" with the time of the last event.
- Unknown, failed and unavailable are shown explicitly, never hidden or smoothed over.

## Navigation

| Section | Purpose | Reads |
|---|---|---|
| Dashboard | Active runs, pending approvals, failures (24 h, by code), spend this month, recent events | runs, approvals, v_run_cost, run_events |
| Runs | All runs: objective, project, status, progress, cost, started, duration | runs, tasks |
| Projects | Criteria defaults, scoring weights, sender profile, default budget, runs | projects |
| Agents | The seven roles: mode, route and current model binding, allowed tools, limits, prompt version; executions, success rate, cost, latency, failure codes | agent definitions (code), agent_executions, llm_calls |
| MCP | Server health; tool catalogue with schemas (rendered from the contracts); per-tool calls, error rates, p95 latency; recent calls; API keys and client sessions | tool_calls, v_tool_stats, api_keys, mcp_sessions |
| Evidence | Source library (domain, tier, retrieved, flags, claims supported); claim explorer by status and attribute | sources, claims, evidence |
| Approvals | Pending inbox; history with actor, time, decision, reason and snapshot hash | approvals |
| Settings | Workspace, members and roles, budgets, model routing (read-only view of config), API keys | workspace tables |

## Built so far (Phase 4)

A thin run view, rendered on the server from the database: runs list, new run (objective, project, seed pages), and a
run page with status, budget meters, stage counts, task table (running only while the lease is live), the pending plan
approval rendered from its stored snapshot, the report with score breakdowns and exclusions, claims by company with
quotes, grounding, judge verdicts and sources, and the latest events. While the run can change on its own, the page
re-reads every 3 seconds and states when its data was read; there is no event stream yet. Not built: the execution
graph, the drill-down drawer, the approvals inbox and the other sections, which the navigation shows as "not built".

## Run page

- **Header:** "Research Run", status badge, objective, budget bar (spent vs limit, from telemetry), elapsed time
  (ticks only while running).
- **Execution graph** (main area), two views of the same rows:
  - **Stage view:** one node per stage (Plan → Discover → Profile / People → Verify → Gap-fill → Analyze → Outreach
    → Approve → Report) with live counts by status. This is the conceptual picture
    (Orchestrator ↓ Research / Company / People → Verify → Analyze → Outreach), built from real task rows.
  - **Task view:** the full DAG with one swimlane per company. Each node shows status, attempts and lease state;
    edges show hard and soft dependencies.
  - Clicking a node opens its drawer: input, output references, executions (turns, tool calls, model calls with
    tokens, cost, latency), events and errors.
- **Side panels:** live activity (the run's event stream), evidence (claims by company with status and confidence),
  approvals (pending, with the snapshot), errors and retries (failed attempts, lease expiries, provider errors).
- **Results:** ranked companies with score breakdowns. Any fact opens the drill-down.

## Drill-down drawer

Finding → Claim (typed value, status, confidence, reasons) → Evidence (quote, grounding result, judge verdict) →
Source (saved text with the span highlighted, retrieval time, URL, tier, flags) → why the URL was allowed → the
execution that proposed it. This path is the product's main selling point, so it must be one click from any fact.

## Approvals

The approval view renders the stored snapshot, not live data, and shows its short hash. Approve or reject; a
rejection requires a reason. The decision submits the hash that was displayed. If the approval was invalidated while
open, the view says the item changed and links to the new version.

## Visual language

Industrial Precision: the full standard is `.claude/skills/ai-ops-ui/SKILL.md`; the tokens live in one Tailwind
`@theme` block in `apps/web/src/app/globals.css` (class names in brackets), with Tailwind's default palette cleared.

| Token | Value |
|---|---|
| Surfaces | canvas `#101113` (`canvas`), surface `#151719` (`panel`), surface 2 `#1B1D20` (`raised`), elevated `#202328` (`elevated`) |
| Borders | `#2A2D31` (`line`), strong `#363A40` (`line-strong`); a divider before a card |
| Text | primary `#F1F0EB` (`ink`), secondary `#A7A9A7` (`ink-muted`), tertiary `#70737A` (`ink-subtle`), disabled `#50535A` (`ink-disabled`) |
| Accent | `#B8E64A` (`accent`), a signal: the primary action, active and selected state, progress, focus. Never a wash or a glow |
| Status | verified/completed `#72C28B` (`ok`), awaiting review `#D6A24A` (`review`), warning `#E0A05A` (`warn`), failed `#D66B67` (`danger`), running `#7EA7D9` (`info`); quiet states in `ink-subtle`. Always a drawn glyph plus a Geist Mono label (`StatusBadge`), never colour alone; labels and mapping in `run-view.ts` |
| Type | Geist for UI, Geist Mono for ids, timestamps, statuses and metadata; weights 400/500/600. Scale: display 48/52, page title 32/36 (26 on mobile), section 20/26 (18), body 14/21, small 13/18, metadata 12/16, mono labels 11 |
| Geometry | 4 px spacing rhythm; radius 6 px controls and small panels, 8 px large panels, 10 px drawers and modals |
| Shell | 216 px sidebar and 56 px top bar on desktop; below 1024 px a top bar with a full-height menu sheet |

## Motion

Only for real state changes: a new event slides into the activity feed, a node changes colour when its status
changes, a live lease shows a subtle indicator. No decorative loops, no simulated typing, no fake agent avatars.
`prefers-reduced-motion` turns motion off.

## Accessibility

WCAG AA contrast on dark surfaces; keyboard navigation for tables, graph and drawers; visible focus rings in the
accent colour; status never conveyed by colour alone.

## Stack

Next.js App Router, React server components for reads, client components for the graph and live panels,
Tailwind with the tokens above as CSS variables, shadcn/ui primitives, React Flow for the graph with a deterministic
layout (stable positions between updates).
