# State machines

Every transition below is one database transaction that also appends a `run_events` row with the next per-run
sequence number. If the transaction commits, the change and its event exist; if it doesn't, neither does. The
database can always tell the complete story.

Actors: **user** (through a domain command, after a role check), **worker** (scheduler or task handler holding a
valid lease), **reaper** (any worker running the lease-recovery function), **system** (derived updates inside
another actor's transaction).

## Task

```
            deps met            claim (lease)          complete (fenced)
 blocked ─────────────► ready ───────────────► running ────────────────► succeeded
    │                     ▲                       │ │
    │ hard dep failed     │ retry (backoff)       │ └──── gate reached ──► waiting_approval ──► succeeded / failed
    ├──────────► skipped  └───────────────────────┤                          (user decision)
    │                                             └── permanent / attempts exhausted ──► failed
    └──── run cancelled ──► cancelled   (from any non-terminal status)
```

| From | To | Actor | Guard | Transaction also does |
|---|---|---|---|---|
| — | blocked / ready | worker or user | idempotency key unique per run | insert dependencies; `ready` if it has none |
| blocked | ready | system | every hard dep `succeeded`, every soft dep terminal | — (runs inside the transaction that finished the last dependency) |
| blocked | skipped | system | a hard dep failed or was skipped | cascades to its own dependents |
| ready | running | worker | `run_after ≤ now`, run is `running` (or `planning` for `plan_run`), budget headroom, concurrency slot | set lease owner, fencing token, expiry; `attempt += 1`; insert `agent_executions` row |
| running | running | worker | holds the lease | heartbeat extends `lease_expires_at` |
| running | succeeded | worker | `lease_token` matches and lease not expired | write outputs; insert expanded tasks; promote dependents; recompute run status |
| running | ready | worker or reaper | transient failure or expired lease, `attempt < max_attempts` | record failure on the execution; `run_after = now + backoff` |
| running | failed | worker or reaper | permanent failure, or attempts exhausted | skip hard dependents; recompute run status |
| running | waiting_approval | worker | handler of a gate task | create approval(s) with frozen snapshot + hash |
| waiting_approval | succeeded | user | every approval of the gate decided; plan approved | promote dependents |
| waiting_approval | failed | user | plan rejected (the run replans, up to 3 revisions, or is cancelled) | — |
| any non-terminal | cancelled | user | run cancel requested | running tasks stop at their next turn boundary |

Terminal statuses: `succeeded`, `failed`, `skipped`, `cancelled`.

### Dependencies

- **hard**: the dependency must succeed. Example: `profile_company → find_people` (no people search without a
  resolved company).
- **soft**: the dependency must be terminal. Examples: `find_people → verify_entity` (company claims are verified even
  if people discovery failed) and joins across companies (`verify_entity → rank_and_analyze`), so one failed company
  doesn't sink the run; it is excluded from the report with its reason.
- A task may gain a dependency only while `blocked`, and only inside the transaction that completes one of its
  existing dependencies. That is how gap-fill adds a second verification round before ranking can start.
- A plan rejection is the one place an edge is replaced. `decideApproval(rejected)` runs one transaction that
  fails `approve_plan` rN, creates `plan_run` and `approve_plan` rN+1, and re-points the still-blocked
  `discover_companies` from rN to rN+1. It is never skipped by the generic "hard dependency failed" rule.

## Leases and crash safety

- Claiming uses `claim_next_task()`, a `SECURITY DEFINER` function: `UPDATE ... WHERE id = (SELECT ... FOR UPDATE
  SKIP LOCKED LIMIT 1)`. Two workers can never hold the same task.
- Lease: 60 s, extended by a heartbeat every 15 s. Long model calls heartbeat from a timer, not from the call.
- Completion is **fenced**: `UPDATE tasks SET status='succeeded' ... WHERE id=$1 AND lease_token=$2 AND status='running'`.
  If zero rows match, the lease was lost, and the whole completion transaction rolls back. A slow worker that lost its
  lease can never commit results.
- `reap_expired_leases()` (also `SECURITY DEFINER`) runs every 10 s in each worker. It marks the execution `abandoned`
  with `LEASE_EXPIRED` and returns the task to `ready` with backoff (or `failed` if attempts are exhausted).

| Crash point | Outcome |
|---|---|
| Worker dies while a task runs | Lease expires; the reaper retries it as a new execution. Tool calls and model calls from the dead attempt stay in the log, and their cost stays in the run's spend. |
| Worker dies inside a transition | The transaction never committed. Nothing happened. |
| Worker dies after commit, before acknowledging | Nothing to redo; the state is already correct. |
| Deploy restarts all workers | SIGTERM: stop claiming, finish or release held leases, exit. Anything unfinished is reaped. |
| Database unavailable | Workers back off; no state is held elsewhere, so nothing is lost. |
| Browser refresh | The UI rebuilds from the database and resumes Realtime from the last event sequence. |

## Retries

| Level | What | Policy |
|---|---|---|
| In-call | Provider 429, 5xx, timeouts, connection errors | Honour `retry-after` (≤ 60 s), else backoff 1 s / 4 s / 10 s; at most 3; counted in `llm_calls.retry_count`. Then the router may switch to a fallback binding. |
| In-loop | Output fails its schema; a tool returns an error | Up to 2 repair turns with the validation errors; tool errors go back to the model, which can adapt |
| Task | The execution failed with a transient class | New execution after `min(30 s × 2^(attempt-1), 10 min)` plus jitter, up to the task type's `maxAttempts` |
| None | Permanent or policy failures (refusal, invalid after repair, budget, rejection) | Fail fast with a typed code; policy decides skip / gap / pause |

Every retry spends budget, and the budget is checked before each claim.

## Idempotency

| Effect | Key |
|---|---|
| Task creation (start, expansion, gap-fill) | `unique (run_id, idempotency_key)`, e.g. `profile:{companyId}`, `verify:{companyId}:r2` |
| Claim write | `unique (run_id, fingerprint)` |
| Evidence write | `unique (claim_id, source_id, quote_sha256)` |
| Source snapshot | `unique (workspace_id, final_url_hash, content_sha256)` |
| URL authorisation | `unique (scope, normalized_url_hash)` |
| Pending approval | at most one pending approval per target |
| Model / tool call rows | id generated before the call; retries update the same row |

Tasks execute at least once; these keys make repeated effects harmless.

## Run

The run status is **derived** from task states plus explicit flags, by one pure function (`deriveRunStatus`),
inside every transaction that changes a task. It is unit-tested exhaustively.

```
draft ──start──► planning ──plan_run ok──► awaiting_plan_approval ──approve──► running ⇄ paused ──► completed
                    ▲                               │                                  │
                    └───────── reject (≤ 3) ────────┘                                  └──► failed
 cancelled ◄── cancel (from any non-terminal status)
```

| Rule (first match wins) | Status |
|---|---|
| cancel requested | `cancelled` |
| a fatal task failed (`plan_run`, `discover_companies`, `rank_and_analyze`, `compile_report`) | `failed` |
| `compile_report` succeeded | `completed` |
| `approve_plan` is waiting | `awaiting_plan_approval` |
| user paused, or budget exhausted, or no task can run and a gate is waiting | `paused` (with reason) |
| `plan_run` is ready or running | `planning` |
| otherwise | `running` |

| Transition | Actor | Mechanism |
|---|---|---|
| draft → planning | user | `startRun`: creates `plan_run`, `approve_plan`, `discover_companies` |
| planning → awaiting_plan_approval | worker | `plan_run` succeeds: brief saved, plan approval created |
| awaiting_plan_approval → running | user | `decideApproval(approved)` |
| awaiting_plan_approval → planning | user | `decideApproval(rejected, reason)`: new `plan_run` revision with the feedback. A third rejection cancels the run. |
| running → paused | worker / user | gate waiting, budget exhausted, or `pauseRun` |
| paused → running | user | approval decided, budget extension approved, or `resumeRun` |
| → completed / failed / cancelled | worker / user | derived as above; `finishedAt` set |

## Agent execution

`running → succeeded | failed | abandoned`. `abandoned` means the lease was lost (crash or timeout). One execution
per task attempt, `unique (task_id, attempt)`.

## Approval

```
pending ──decide──► approved / rejected
   └────────────► invalidated ──► (a new pending approval replaces it)
```

1. The gate handler builds the snapshot (exactly what will be shown), canonicalises it (RFC 8785), hashes it, stores both.
2. The UI renders the stored snapshot, not live data, and shows the short hash.
3. `decideApproval` must carry `snapshotHashSeen`. If it differs from the stored hash, the command is refused.
4. Actor, time, decision and reason are stored. A rejection needs a reason.
5. Snapshots, hashes and approved artifact versions cannot be updated (database triggers).
6. Before an approved item is used (e.g. `compile_report` includes an outreach draft), code rebuilds the snapshot from
   current data and compares hashes. On mismatch (the draft changed, or a cited claim changed status) the approval is
   `invalidated` with a reason and a new approval is requested. Nothing silently uses a changed version.

## Claim and gap

```
proposed ─grounding─► grounded ─policy─► verified | probable | stale
    └─quote not found─► rejected      └─judge says no / outside criteria─► rejected
verified | probable ──conflicting claim──► contested
```

Gap: `open → filled` (a later claim satisfied it) or `open → unavailable` (still missing after the bounded gap-fill round).
