# ADR-0004: Verification is deterministic first; confidence is computed by code

- Status: Accepted, 2026-09-30

## Context
Models cite quotes that aren't in the source, shorten them, change characters, and state confidence numbers that
aren't calibrated. A verification "agent" that re-asks a model would inherit the same failure modes.

## Decision
Verification is a pipeline:
1. schema;
2. grounding: the quote must be in the saved snapshot, with Unicode normalisation, rules for elisions, a minimum
   length, and the value present in the quote;
3. one narrow model judgment: does this quote support this claim;
4. versioned per-attribute policies: authority, independence including syndication detection, recency;
5. conflict detection;
6. entity resolution;
7. criteria;
8. coverage gaps.

Confidence is a documented function of evidence features, written with its reasons.

## Consequences
- A claim can't be verified by a model's say-so; every status has machine-readable reasons.
- Weaker or cheaper models lower the yield (more rejected claims, more retries), not the correctness of the report.
- Policies are testable with tables, and the policy version is stored on each claim.
- Rules need tuning; the eval suite measures verification accuracy against expected statuses.

## Alternatives considered
- **LLM verifier agent with free-form judgment:** unexplainable, uncalibrated, and injectable by the very pages it checks.
- **Model-supplied confidence:** looks precise, isn't.
