# ADR-0003: MCP is a capability layer, not a workflow engine

- Status: Accepted, 2026-09-30

## Context
The original brief listed MCP tools for tasks, approvals and writes (`create_task`, `update_task`,
`request_human_approval`, `save_entity`, `store_evidence`, `verify_claim`). Agents read untrusted web content, and a
model steered by a malicious page must not be able to change workflow state.

## Decision
The MCP server exposes six capability tools: `web_search`, `fetch_page`, `lookup_company`, `find_company_people`,
`search_knowledge`, `get_source`. Task creation and scheduling, workflow transitions, approval decisions, claim and
finding writes, and arbitrary database writes stay in domain code. Evidence capture is a side effect of fetching: every
fetched page becomes a snapshot, so agents can't cite what they didn't fetch. Verification runs on every claim in code;
it is not a tool an agent decides to call.

## Consequences
- No model ever holds a tool that changes workflow state, even when prompt-injected.
- Persistence is deterministic: a validated output is saved exactly once by the completion transaction.
- The server has a real reason to exist: one enforcement point for egress, keys, permissions, rate limits and audit,
  usable by any MCP client.
- The tool surface stays small and meaningful.

## Alternatives considered
- **Workflow tools in MCP:** would make the orchestrator a model and the workflow unreliable and injectable.
- **In-process tools without MCP:** simpler, but loses the independent, reusable, separately secured capability layer.
