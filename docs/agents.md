# Agents

An agent role is **code**: a purpose, input and output schemas, allowed tools, a model route, limits, failure
behaviour and a prompt version. Roles are not database rows and not editable at runtime; changing one is a
reviewed code change with its own evals ([ADR-0008](adr/0008-agent-loops-only-where-open-ended.md)). Each
execution records the role, its version and the prompt hash.

## When a loop, when a call

A tool-using loop is worth its cost only when the path to the answer can't be specified in advance: which query to
try next, which link to follow, when enough evidence has been found. That is true for open-web research and false
for everything else in this workflow.

| Role | Mode | Route | Tools | Reads raw web text? |
|---|---|---|---|---|
| Research | **tool loop** | agent_loop | web_search, fetch_page, search_knowledge, get_source | yes |
| Company Intelligence | **tool loop** | agent_loop | lookup_company, web_search, fetch_page, search_knowledge, get_source | yes |
| People Discovery | **tool loop** | agent_loop | find_company_people, web_search, fetch_page, get_source | yes |
| Planner (orchestrator) | structured call | planning | none | no (objective only) |
| Verifier | structured calls (batched) | judge | none | quotes + surrounding context only |
| Analyst | structured call + code scoring | analysis | none | no (claim statements only) |
| Outreach writer | structured call | writing | none | no (claim statements only) |

The orchestrator is the scheduler (code) plus the planner (one call). There is no managing agent that chats with
other agents.

## The tool loop

1. Validate the task input against the role's input schema; render the system prompt (frozen per role version) and
   the task message.
2. Mint a capability token for this execution (tools = the role's allowlist) and open an MCP client.
3. Call the model with the role's tools plus a `submit_result` tool whose schema is the role's output schema.
4. For each tool call: check the name is allowed, call the MCP server, persist the call, append the result.
   Several calls in one turn run concurrently and their results go back together.
5. Loop until `submit_result` is called or a limit is hit (turns, tool calls, output tokens, wall time).
6. If the model stops without submitting: one nudge. Then, where the provider supports forced tool choice, force
   `submit_result`; otherwise make one final call with a schema-constrained response.
7. Validate the result with Zod; on failure, up to 2 repair turns carrying the validation errors.
8. Return the output to the task handler, which grounds and persists it in the completion transaction.

Implemented rules (Phase 3): the last turn is reserved for the result (forced `submit_result`, or one
schema-constrained answer), so reaching the turn limit never throws away what was found; a tool that reports it
can't work in this execution (non-retryable `PROVIDER_UNAVAILABLE`, e.g. no search key) stops being offered; a result
may cite only sources the model read in the same execution, checked before it is accepted; the run budget is checked
before every model call, and running out mid-attempt pauses the run for an extension instead of failing the task.

Added in Phase 4, from live runs through the UI:
- **Pacing.** A role can declare that a tool is withheld after N calls without a successful call of another (not
  offered, refused if called anyway) and the model is told why. Discovery pauses `web_search` after 2 searches without
  a page read; only reading a page not read before restores it (the model had learned to re-read one page to reopen
  search). The model had been searching until its turns ran out without opening a single result.
- **No repeats.** An exact repeat of a call that already succeeded (same tool, same arguments) is refused without
  reaching the server; a failed call may be repeated.
- **Small history.** Search results reach the model with snippets cut to 300 characters and without internal ids;
  every later turn resends them, and full snippets made one 20-turn run cost 528k tokens. The logs keep everything.
- **Nudge.** A model that stops early is invited to keep working (open other results, try other words) or submit; the
  forced submit comes second.
- **Advisory checks** can send a result back at most once, and only with turns and tool calls left: discovery sends
  back an empty result when search found results but no page was read, and a result short of the brief's company count
  while search offered results that were not opened. They never turn an honest result into a failure.
- **Quote shape.** Discovery checks every quote with the grounding rules that need no source text (at least 4 words;
  parts between "..." at least 20 characters), so a short quote becomes a repair, not a lost claim.
- **Salvage.** When no repair turn is left, a role can keep the valid part of a result: discovery drops claims and
  quotes that cite sources not read in the execution, and quotes too short to ground, records every drop, and still fails if nothing valid remains
  (a failed result is never passed off as an empty one).

Every turn is persisted as it happens (`agent_messages`, `llm_calls`, `tool_calls`). Conversations are append-only:
history is never rewritten mid-loop (current Claude models reject edited history on newer API accounts). Context size
is controlled by small tool results (page chunks, with `get_source` to read further) and bounded turns. Tool results
that carry page text are stored as references to the snapshot, not as copies.

Provider differences found in the 2026-09-30 compatibility test: gpt-oss-120b never issued parallel tool calls, so
the loop must not rely on them; forced tool choice works on Earthruntime but not on Claude Opus 5.5 / Sonnet 5.5, so
it is a per-model capability, not an assumption ([llm.md](llm.md)).

## The structured call

Render input → one model call with a schema-constrained response → Zod validation → up to 2 repairs → code
post-processing. No tools, no loop.

## Roles

### Research
- **Tasks:** `discover_companies` (criteria → candidates), `gap_fill` (named gaps → claims).
- **Output:** `ProposedClaim[]` (discovery uses `new_company` subjects with a domain hint).
- **Limits:** discovery 20 turns / 30 tool calls, `web_search` paced at 2 per page read; gap-fill 8 turns / 20 tool
  calls.
- **Code after:** drop candidates without grounded evidence; deterministic pre-score for expansion.

### Company Intelligence
- **Task:** `profile_company`. Structured providers first (`lookup_company` for registry identity), then the web.
- **Output:** `ProposedClaim[]` for company attributes, plus registry identifiers.
- **Limits:** 10 turns / 25 tool calls, `web_search` paced at 2 per page read.
- **Implemented** as `company.profile@1`, web only (registries come with `lookup_company`). It gets the company, the
  statements discovery saved, the evidence pages, and the company's site when an article links to it. It proposes
  claims with the subject `{"kind": "company", "companyId"}`; claims about anyone else are sent back once, then dropped.
- **Code after:** proposals pinned to the company, grounded and written like discovery's; the domain recorded only
  from evidence ([provenance.md](provenance.md#which-site-is-the-companys-own)), never from the agent's say-so.
- **Website claims:** a page describing the company does not show who owns the page. The verifier rightly refused
  such quotes as evidence for "X's website is U" in the 2026-10-07 eval recording, so the agent proposes
  `company.website` only when a page states the address in words; which site is the company's is code's decision.

### People Discovery
- **Task:** `find_people`. Registries first (`find_company_people`), then the company's own team page and press.
- **Rules (enforced by schema and verification, not only the prompt):** only people named in a saved source; no
  contact details of any kind; titles as stated; role claims older than the policy window become `stale`.
- **Output:** `ProposedClaim[]` with `new_person` subjects and `person.current_role` claims.
- **Limits:** 8 turns / 20 tool calls.
- **Implemented** as `people.discovery@1` (web only: the server does not offer `find_company_people` until registry
  providers exist). Contact details are refused three times over: the loop sends a result carrying one back for
  repair, salvage drops it at the last turn, and `persistPeople` drops and counts any that reach it.

### Planner
- **Input:** objective, today's date, project defaults (sector keywords, countries, roles, weights), rejection
  feedback from a previous revision.
- **Output:** `InterpretedCriteria`, `Assumption[]`, open questions.
- **Code after:** region names → country lists, date window validation, limits clamped, cost estimate added.
- **Implemented** as `planner@1` (structured call on the planning route); `normalizePlan` and `planSnapshot` in
  `packages/core/src/workflow/plan.ts`.

### Verifier
- **Input:** batches of `{claim statement, quote, ±300 characters of surrounding snapshot text}` prepared by code.
  Only grounded quotes reach it.
- **Output:** one `JudgeVerdict` + short reason per item.
- Everything else in verification is code ([provenance.md](provenance.md#verification)).
- **Implemented** as `verifier@1` (judge route, batches of 20, every index answered exactly once or repaired).

### Analyst
- **Input:** per company: verified/probable claim statements with ids, the score breakdown computed by code, the criteria.
- **Output:** findings labelled `analysis`, `inference`, `recommendation` or `risk`, each citing claim ids.
- **Code after:** reject findings citing unknown, out-of-scope or unverified claims.

### Outreach writer
- **Input:** verified claim statements (with ids) for one company and its decision makers; the project's sender
  profile; channel.
- **Output:** subject, body, and `personalization[]` with claim ids per personal detail.
- **Code after:** every cited claim is verified and belongs to that company/person; length and channel limits.
  Drafts are never sent by the system.

## Untrusted content

Roles that read web text have read-only tools, no secrets in context, and a capability token scoped to one
execution. Roles that produce outward-facing text (analyst, writer) never see raw web text, only claim statements
rendered by code. Details in [provenance.md](provenance.md#prompt-injection) and [security.md](security.md).
