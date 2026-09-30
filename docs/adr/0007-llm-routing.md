# ADR-0007: Provider-agnostic LLM layer with route classes

- Status: Accepted, 2026-09-30

## Context
Tasks differ in what they need (planning, tool loops, cheap judgments, writing). Providers differ in capabilities
(forced tool choice, parallel calls, caching, reasoning controls) and change over time. Claude Code Max does not
cover application API usage.

## Decision
- Our own `LlmProvider` interface over the official SDKs, with a router: agents declare a route class, and versioned
  config maps each class to ordered model bindings.
- Capabilities are per-model config, and the loop never assumes one.
- Adapters: Anthropic first; OpenAI-compatible second (Earthruntime today).
- Every call records model, provider, route, tokens, cache status, cost, latency and retries.
- A model without a price entry can't be routed to.

## Consequences
- Switching a task's model is a config change, measured by evals before it ships.
- Fallback on availability failures only; quality differences are handled by evals, not silent switching.
- Two adapters to maintain.

## Alternatives considered
- **Vercel AI SDK agent loop:** we need per-turn persistence and our own tool execution; its abstraction would sit
  between us and provider details we rely on (cache metrics, thinking-block replay).
- **Provider-hosted agents and tools (managed agents, server-side web tools, MCP connectors):** bypass our evidence
  capture, URL policy and provider independence.
