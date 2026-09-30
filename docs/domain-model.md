# Domain model

The contracts live in [`packages/contracts/src`](../packages/contracts/src) as Zod schemas. They are the single
definition used by the web app, the worker, the MCP server, the evals and (through a drift test) the database.
Every cross-boundary value is parsed with them: server-action input, MCP tool input and output, LLM output,
provider responses and task payloads.

## Entities

```
Workspace ─< Project ─< Run ─< Task ─< AgentExecution ─< LlmCall
                         │      │                     └─< ToolCall ─> SourceSnapshot
                         │      └─< TaskDependency
                         ├─< RunEvent (timeline)
                         ├─< Approval (frozen snapshot + hash)
                         ├─< Claim ─< Evidence ─> SourceSnapshot ─> DiscoveredUrl
                         ├─< ResearchGap
                         ├─< Finding >─< Claim
                         └─< Artifact >─< Claim / Finding
Workspace ─< Company, Person, EntityIdentifier   (knowledge persists across runs)
```

| Contract | File | Answers |
|---|---|---|
| `Run`, `ResearchBrief`, `InterpretedCriteria`, `Assumption`, `Budget`, `Spend` | [run.ts](../packages/contracts/src/run.ts) | What was asked, how it was interpreted, what was assumed, what it may spend, where it stands |
| `Task`, `TaskInput`, `TaskOutputRef`, `Lease`, `TaskDependency` | [task.ts](../packages/contracts/src/task.ts) | What unit of work, depending on what, who holds it, how many attempts, what it produced |
| `AgentExecution`, `LlmCall`, `ToolCall` | [execution.ts](../packages/contracts/src/execution.ts) | Which agent did it, with which model and tools, at what cost and latency, with which retries |
| `DiscoveredUrl`, `SourceSnapshot`, `Evidence` | [provenance.ts](../packages/contracts/src/provenance.ts) | Why a URL was fetchable, what was saved, which exact span supports a claim |
| `Claim`, `ClaimAssertion`, `Verification`, `ResearchGap`, `ProposedClaim` | [claim.ts](../packages/contracts/src/claim.ts) | What exactly we assert, how sure we are and why, what we could not find |
| `Approval`, `ApprovalSnapshot`, `ApprovalDecision` | [approval.ts](../packages/contracts/src/approval.ts) | What a human approved, exactly, and when |
| `Finding`, `Artifact` | [output.ts](../packages/contracts/src/output.ts) | What the user reads, and what every part of it rests on |
| Tool inputs/outputs, `CapabilityTokenClaims` | [tools.ts](../packages/contracts/src/tools.ts) | The MCP contract |
| `RunEvent` | [events.ts](../packages/contracts/src/events.ts) | The run's story, in order |
| Commands | [commands.ts](../packages/contracts/src/commands.ts) | The only ways a user changes workflow state |
| `TASK_DEFINITIONS`, `AGENT_TOOLS`, `AGENT_ROUTES` | [workflow.ts](../packages/contracts/src/workflow.ts) | The workflow as data |

## Conventions

- **Ids** are UUIDs with a brand per entity (`RunId`, `TaskId`, ...). Mixing them is a compile error.
- **Money** is integer micro-US-dollars (`UsdMicros`). Sums are exact; no floats in budgets.
- **Time** is ISO 8601 with offset. Dates are `YYYY-MM-DD`.
- **Hashes** are lowercase hex SHA-256. Snapshot hashes use RFC 8785 canonical JSON.
- **Enums in Postgres** are `text` with `CHECK` constraints generated from the Zod enums; a test fails if they drift.
- Every invariant a schema checks with `superRefine` is also a `CHECK` constraint or trigger in the database where SQL can express it.

## Claims: "what exactly are we asserting?"

A claim is one typed assertion about one entity:

| Field | Example | Purpose |
|---|---|---|
| `subject` | `{ kind: 'company', companyId }` | Who it is about |
| `assertion.attribute` | `company.funding_round` | What property, from a fixed catalogue |
| `assertion.value` | `{ stage: 'series_a', amount: 12000000, currency: 'EUR', announcedOn: '2026-06-18', leadInvestors: ['Northwind Ventures'] }` | The normalised, typed value |
| `rawValue` | `€12 million Series A` | How the source phrased it |
| `statement` | `Quillmark Security raised a Series A of EUR 12,000,000 on 2026-06-18.` | Rendered by code from the assertion. Reports show this. |
| `evidenceIds` | ≥ 1 | The quotes it rests on |
| `sourceDates` | newest/oldest published, newest retrieved | For recency rules |
| `verification` | status, confidence, reasons, policy id + version | The verdict and why |
| `conflict` | none / conflicting / superseded | Relationship to competing claims |
| `provenance` | proposing agent + execution | Who proposed it |
| `fingerprint` | sha256(subject, attribute, canonical value) | Idempotent writes; unique per run |

### Attribute catalogue (v1)

| Attribute | Value | Required for coverage |
|---|---|---|
| `company.website` | url | yes |
| `company.hq_country` | ISO country | yes |
| `company.hq_city` | city | |
| `company.founded_year` | year | |
| `company.description` | short text | |
| `company.sector` | tags | yes |
| `company.funding_round` | stage, amount + currency (or both null), date, investors | yes |
| `company.employee_count` | range | |
| `company.hiring_signal` | summary, open roles | |
| `company.registry_id` | scheme + id | |
| `person.current_role` | company, title, normalised role, since | yes (per person) |
| `person.public_profile` | url + kind | |

### Claim statuses

| Status | Meaning |
|---|---|
| `proposed` | An agent proposed it; nothing checked yet |
| `grounded` | Every cited quote was found in its saved snapshot |
| `verified` | Grounded, judged as supported, and the attribute's policy is met (authority, independence, recency) |
| `probable` | Grounded and supported, but the policy is only partly met (e.g. a single non-authoritative source) |
| `contested` | Another claim asserts a conflicting value; both are kept and shown |
| `stale` | Supported, but the newest source is older than the attribute allows |
| `rejected` | Quote not found, judged unsupported, or outside the brief's criteria |

"Verified / probable / inferred / unavailable" from the product brief map to: `verified`; `probable`;
`inferred` = a finding labelled `inference` (never a claim); `unavailable` = a `ResearchGap` with status `unavailable`.

## Findings and artifacts: no AI-generated facts

| Finding label | Written by | Allowed content |
|---|---|---|
| `fact_derived` | code | Assembled from claim statements (e.g. the score breakdown) |
| `analysis` | model | Interpretation that cites ≥ 1 basis claim, visibly labelled |
| `inference` | model | A conclusion not stated by any source, visibly labelled, cites its basis claims |

Enforced by the `Finding` schema (a model can't author `fact_derived`) and by code that checks cited claim ids exist,
belong to the subject, and are `verified` or `probable`.

Artifacts are immutable versions. The prospect report references findings, claims, gaps and approved outreach
drafts by id; the Markdown/HTML/CSV renderings are produced from those references, so every sentence of a rendered
report maps to a row. An outreach draft lists each personal detail with the verified claim ids it comes from;
code refuses a draft that cites anything unverified or out of scope.

## Invariants (enforced in schema and SQL)

- A task holds a lease exactly while `running`; it has an output exactly when `succeeded`.
- A company task's input refers to the same company as its subject.
- A claim's attribute matches its subject kind; it has ≥ 1 evidence row; confidence exists exactly for
  `verified`, `probable` and `contested`.
- Evidence spans are empty exactly when the quote was not found; ungrounded evidence never reaches the judge.
- A fetched snapshot references the `DiscoveredUrl` that authorised it; a provider record has a `provider_record` origin.
- An approval's `type`, `target.type` and `snapshot.kind` agree; a decision quotes the snapshot hash it was made on;
  a rejection has a reason.
- A score finding is authored by code; a model-authored finding is labelled `analysis` or `inference`.
