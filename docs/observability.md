# Observability

Designed from day one: the data is captured from the first model call in Phase 3, and the UI to explore it comes in
Phase 6. The same rows serve the UI, cost accounting, evals and debugging.

## Trace hierarchy

```
Run ─► Task ─► AgentExecution ─► LlmCall
                              └─► ToolCall ─► SourceSnapshot
```

Every row and every log line carries the ids above it (workspace, run, task, execution, call). Any event can be
followed up to its run or down to the exact model request and tool response.

## What is persisted

| Question | Source |
|---|---|
| What happened, in order? | `run_events` (typed, gap-free per-run sequence) |
| When did each task become ready, get claimed, finish? How many attempts? | `tasks`, `task.status_changed` events, `agent_executions` |
| What did the agent see and say? | `agent_messages` (append-only conversation; page text by reference) |
| Which model, how many tokens, how much, how long, how many retries, cache hit? | `llm_calls` |
| Which tool, with what arguments, what result, which provider, how long, what error? | `tool_calls` |
| What was retrieved, when, from where, and why was it allowed? | `sources`, `discovered_urls` |
| Why is this claim verified / rejected? | `claims.verification` reasons + `evidence` grounding and judge verdicts |
| Who approved what, when, on which version? | `approvals` |
| Who did something security-relevant? | `audit_logs` |

## Metrics (SQL views)

| View | Contents |
|---|---|
| `v_run_cost` | Cost and tokens per run, by model, route and agent |
| `v_task_timeline` | Per task: time ready, time running, attempts, outcome |
| `v_llm_stats` | Per model and route: calls, tokens, cost, cache hit rate, retry rate, refusals, truncations, p50/p95 latency |
| `v_tool_stats` | Per tool and provider: calls, error rate by code, cache hit rate, p50/p95 latency |
| `v_verification_outcomes` | Per run: claims by status and reason code; grounding failures by agent |
| `v_approval_latency` | Time from request to decision, by type |

## "Why did the system say this?"

Every visible statement drills down to its origin:

```
Report line
  → Finding (score breakdown, or labelled analysis with the model execution that wrote it)
    → Claim (typed value, status, confidence, reasons, policy version)
      → Evidence (quote, grounding result, judge verdict and reason)
        → Source snapshot (the saved text with the span highlighted, retrieval time, HTTP metadata, hash)
          → Discovered URL (the search, link or provider record that allowed the fetch)
      → Execution that proposed it (turns, tool calls, model calls, cost)
```

## Logs

Structured JSON (pino). Fields: level, time, service, env, workspaceId, runId, taskId, executionId,
llmCallId/toolCallId, event, message. Redacted paths: authorization headers, cookies, API keys, tokens, passwords,
connection strings. Logs are for operators; the database is the product's record.

## Realtime

The run page subscribes to inserts on `run_events` for that run (RLS applies to Realtime). On reconnect it fetches
events with `seq` greater than the last one it rendered, so nothing is missed or duplicated. When the socket is down,
the UI says so and shows the time of the last event instead of pretending to be live.

## Later

OpenTelemetry export using the GenAI semantic conventions, so traces can also go to an external backend. The
product's own observability never depends on an external vendor.
