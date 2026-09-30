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
| ready | running | worker | `run_after ≤ now`; run `planning`, `awaiting_plan_approval` or `running`, not cancelled, paused or budget-blocked; fewer than 4 of the run's tasks running; the worker has a handler for the type | set lease owner, fencing token, expiry; `attempt += 1`. The budget is then checked under the run lock: work that would not fit goes back to `ready` without counting the attempt, and the run pauses for a budget extension. (Phase 3 adds the `agent_executions` row.) |
| running | running | worker | holds the lease | heartbeat extends `lease_expires_at` |
| running | succeeded | worker | `lease_token` matches and lease not expired | write outputs; insert expanded tasks; promote dependents; recompute run status |
| running | ready | worker or reaper | transient failure (incl. `LEASE_EXPIRED`, `TASK_TIMEOUT`), `attempt < max_attempts` | record the failure; `run_after = now + backoff` |
| running | ready | worker | shutdown or pause before the handler started | release: lease cleared, attempt not counted |
| running | failed | worker or reaper | permanent failure, or attempts exhausted | skip hard dependents; recompute run status |
| running | waiting_approval | worker | handler of a gate task | create approval(s) with frozen snapshot + hash |
| waiting_approval | succeeded | user | every approval of the gate decided; plan approved | promote dependents |
| waiting_approval | failed | user | plan rejected (the run replans, up to 3 revisions, or is cancelled) | — |
| any non-terminal | cancelled | user | run cancel requested | not-yet-running tasks at once; a running task at its next heartbeat (its handler's signal is aborted) or completion, and its result is discarded |

Terminal statuses: `succeeded`, `failed`, `skipped`, `cancelled`.

### Dependencies

- **hard**: the dependency must succeed. Example: `profile_company → find_people` (no people search without a
  resolved company).
- **soft**: the dependency must be terminal. Examples: `find_people → verify_entity` (company claims are verified even
  if people discovery failed) and joins across companies (`verify_entity → rank_and_analyze`), so one failed company
  doesn't sink the run; it is excluded from the report with its reason.
- A task may gain a dependency only while `blocked` (enforced by the engine, which also rejects any change that
  would create a cycle). In practice it happens inside the transaction that completes another task: that is how
  gap-fill adds a second verification round before ranking can start.
- A plan rejection is the one place an edge is replaced. `decideApproval(rejected)` runs one transaction that
  fails `approve_plan` rN, creates `plan_run` and `approve_plan` rN+1, and re-points the still-blocked
  `discover_companies` from rN to rN+1. It is never skipped by the generic "hard dependency failed" rule.

## Leases and crash safety

- Claiming uses `claim_next_task()`, a `SECURITY DEFINER` function. Candidate tasks are locked `FOR UPDATE SKIP
  LOCKED`, so two workers can never hold the same task. The per-run limit (4 running tasks) is exact: claims of one
  run serialise on a transaction-level advisory lock and re-count the run's running tasks under it. Transitions never
  take that lock, so a claim doesn't skip a run just because one of its tasks is being started or completed (an
  earlier version locked the run row and left workers idling on busy runs).
- Every transition locks the run row first, then the task, then approvals. One lock order everywhere means no
  deadlocks, and two sibling tasks finishing at the same moment can never both miss promoting their dependent.
- Lease: 60 s, extended by a heartbeat every 15 s from a timer, not from the handler (the heartbeat interval must be
  at most half the lease). The heartbeat also reports a cancelled run, which aborts the handler's signal.
- One attempt may run for at most 20 minutes; past that it fails with `TASK_TIMEOUT` (transient, so it is retried).
  The scheduler records the outcome without waiting for a handler that ignores its signal: the lease token makes
  any late result from it fail to commit.
- Completion is **fenced**: `UPDATE tasks SET status='succeeded' ... WHERE id=$1 AND lease_token=$2 AND status='running'`.
  If zero rows match, the lease was lost, and the whole completion transaction rolls back. A slow worker that lost its
  lease can never commit results.
- `reap_expired_leases()` (also `SECURITY DEFINER`) runs every 15 s in each worker. It takes over the expired lease
  with a new token (fencing out the old worker), then the normal transition records `LEASE_EXPIRED` and returns the
  task to `ready` with backoff (or `failed` if attempts are exhausted). From Phase 3 it also marks the execution
  `abandoned`.

| Crash point | Outcome |
|---|---|
| Worker dies while a task runs | Lease expires; the reaper retries it as a new execution. Tool calls and model calls from the dead attempt stay in the log, and their cost stays in the run's spend. |
| Worker dies inside a transition | The transaction never committed. Nothing happened. |
| Worker dies after commit, before acknowledging | Nothing to redo; the state is already correct. |
| Deploy restarts all workers | SIGTERM: stop claiming, let running handlers finish for up to 10 s, hand the rest back to `ready` without counting the attempt, exit. Anything a killed process held is reaped. |
| Database unavailable | Workers back off; no state is held elsewhere, so nothing is lost. |
| Browser refresh | The UI rebuilds from the database and resumes Realtime from the last event sequence. |

## Retries

| Level | What | Policy |
|---|---|---|
| In-call | Provider 429, 5xx, timeouts, connection errors | Honour `retry-after` (≤ 60 s), else backoff 1 s / 4 s / 10 s; at most 3; counted in `llm_calls.retry_count`. Then the router may switch to a fallback binding. |
| In-loop | Output fails its schema; a tool returns an error | Up to 2 repair turns with the validation errors; tool errors go back to the model, which can adapt |
| Task | The execution failed with a transient class | New execution after `min(30 s × 2^(attempt-1), 10 min)` plus jitter, up to the task type's `maxAttempts` |
| None | Permanent or policy failures (refusal, invalid after repair, budget, rejection, `PROVIDER_ACCOUNT`: the provider refused our key or our credit is used up) | Fail fast with a typed code; policy decides skip / gap / pause |

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
| no tasks yet | `draft` |
| a fatal task failed (`plan_run`, `discover_companies`, `rank_and_analyze`, `compile_report`) | `failed` (with that task's failure) |
| `compile_report` succeeded | `completed` |
| every task terminal, but `compile_report` never ran | `failed` (`DEPENDENCY_FAILED`) |
| user paused | `paused` (`user_requested`) |
| budget exhausted | `paused` (`budget_exhausted`) |
| `approve_plan` is ready, running or waiting | `awaiting_plan_approval` |
| `plan_run` is ready or running | `planning` |
| nothing ready or running, and a gate is waiting | `paused` (`awaiting_approval`) |
| otherwise | `running` |

A run cannot reach `awaiting_plan_approval`, `running` or `completed` without a saved brief (a CHECK constraint);
`plan_run` saves it with `saveBrief` in its completion transaction.

| Transition | Actor | Mechanism |
|---|---|---|
| draft → planning | user | `startRun`: creates `plan_run`, `approve_plan`, `discover_companies` |
| planning → awaiting_plan_approval | worker | `plan_run` succeeds: brief saved, plan approval created |
| awaiting_plan_approval → running | user | `decideApproval(approved)` |
| awaiting_plan_approval → planning | user | `decideApproval(rejected, reason)`: new `plan_run` revision with the feedback. A third rejection cancels the run. |
| running → paused | worker / user | gate waiting, budget exhausted, or `pauseRun` (stops new claims; running tasks finish) |
| paused → running | user | approval decided, budget extension approved, or `resumeRun` |
| paused (budget) stays paused | user | extension rejected. `resumeRun` lets the scheduler try again: if the budget still doesn't fit, the run pauses and asks for an extension again |
| → completed / failed / cancelled | worker / user | derived as above; `finishedAt` set |

## Agent execution

`running → succeeded | failed | abandoned`. `abandoned` means the lease was lost (crash, timeout or shutdown). One execution
per task lease, `unique (task_id, lease_token)`.

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
