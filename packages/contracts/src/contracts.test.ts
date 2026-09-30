import { randomUUID } from 'node:crypto';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  type ClaimAssertion,
  type ClaimAttribute,
  AGENT_MODES,
  AGENT_TOOLS,
  Approval,
  Claim,
  Evidence,
  FetchPageInput,
  Finding,
  LookupCompanyInput,
  Run,
  Task,
  TASK_DEFINITIONS,
  TOOL_CONTRACTS,
  WebSearchInput,
} from './index';

const id = () => randomUUID();
const now = new Date().toISOString();
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

function issuePaths(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
}

describe('Claim', () => {
  it('has an assertion variant for exactly every attribute', () => {
    expectTypeOf<ClaimAssertion['attribute']>().toEqualTypeOf<ClaimAttribute>();
  });

  const verification = {
    status: 'verified',
    confidence: 'high',
    confidenceScore: 0.86,
    reasons: [{ code: 'AUTHORITATIVE_SOURCE', detail: 'Company press release', evidenceIds: [id()] }],
    policy: { id: 'company.funding_round', version: 1 },
    evaluatedAt: now,
    evaluatedByTaskId: id(),
  };
  const fundingValue = {
    stage: 'series_a',
    amount: 12_000_000,
    currency: 'EUR',
    announcedOn: '2026-06-18',
    leadInvestors: ['Northwind Ventures'],
    otherInvestors: [],
  };
  const claim = {
    id: id(),
    workspaceId: id(),
    runId: id(),
    subject: { kind: 'company', companyId: id() },
    assertion: { attribute: 'company.funding_round', value: fundingValue },
    rawValue: '€12 million Series A',
    statement: 'Quillmark Security raised a Series A of EUR 12,000,000 on 2026-06-18.',
    fingerprint: hashA,
    evidenceIds: [id()],
    sourceDates: { newestPublishedAt: now, oldestPublishedAt: now, newestRetrievedAt: now },
    verification,
    conflict: { state: 'none', conflictingClaimIds: [], supersededBy: null },
    provenance: { proposedByAgent: 'research', proposedByExecutionId: id(), proposedAt: now },
  };

  it('accepts a verified funding-round claim', () => {
    expect(Claim.safeParse(claim).success).toBe(true);
  });

  it('rejects confidence on an unevaluated claim', () => {
    const proposed = { ...claim, verification: { ...verification, status: 'proposed', evaluatedAt: null } };
    expect(issuePaths(Claim, proposed)).toContain('verification.confidence');
  });

  it('rejects an attribute that does not fit the subject', () => {
    const wrong = {
      ...claim,
      assertion: {
        attribute: 'person.public_profile',
        value: { url: 'https://example.com/team', kind: 'company_team_page' },
      },
    };
    expect(issuePaths(Claim, wrong)).toContain('assertion.attribute');
  });

  it('rejects an amount without a currency', () => {
    const wrong = {
      ...claim,
      assertion: { attribute: 'company.funding_round', value: { ...fundingValue, currency: null } },
    };
    expect(issuePaths(Claim, wrong)).toContain('assertion.value');
  });
});

describe('Approval', () => {
  const budget = { maxCostUsdMicros: 2_000_000, maxLlmTokens: 4_000_000, maxToolCalls: 400, maxWallClockSeconds: 3600 };
  const approval = {
    id: id(),
    workspaceId: id(),
    runId: id(),
    taskId: id(),
    type: 'budget_extension',
    target: { type: 'budget_extension', runId: id() },
    snapshot: {
      kind: 'budget_extension',
      current: budget,
      spent: { costUsdMicros: 2_000_000, llmInputTokens: 3_900_000, llmOutputTokens: 100_000, toolCalls: 310 },
      requested: { ...budget, maxCostUsdMicros: 3_000_000 },
      reason: 'Two companies still have open gaps',
    },
    snapshotHash: hashA,
    snapshotSchemaVersion: 1,
    status: 'approved',
    requestedAt: now,
    decision: { decision: 'approved', actorId: id(), decidedAt: now, snapshotHashSeen: hashA, reason: null },
    invalidation: null,
  };

  it('accepts an approved budget extension', () => {
    expect(Approval.safeParse(approval).success).toBe(true);
  });

  it('requires a reason to reject', () => {
    const rejected = { ...approval, status: 'rejected', decision: { ...approval.decision, decision: 'rejected' } };
    expect(issuePaths(Approval, rejected)).toContain('decision.reason');
  });

  it('refuses a decision made on a different snapshot', () => {
    const stale = { ...approval, decision: { ...approval.decision, snapshotHashSeen: hashB } };
    expect(issuePaths(Approval, stale)).toContain('decision.snapshotHashSeen');
  });
});

describe('Task', () => {
  const companyId = id();
  const task = {
    id: id(),
    runId: id(),
    workspaceId: id(),
    type: 'profile_company',
    kind: 'agent_loop',
    status: 'ready',
    subject: { kind: 'company', companyId },
    input: { type: 'profile_company', companyId },
    output: null,
    idempotencyKey: `profile:${companyId}`,
    parentTaskId: id(),
    dependsOn: [{ dependsOnTaskId: id(), mode: 'hard' }],
    attempt: 0,
    maxAttempts: 2,
    runAfter: now,
    lease: null,
    lastFailure: null,
    priority: 50,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };

  it('accepts a ready company task', () => {
    expect(Task.safeParse(task).success).toBe(true);
  });

  it('requires a lease while running', () => {
    expect(issuePaths(Task, { ...task, status: 'running' })).toContain('lease');
  });

  it('requires input for its own type and subject', () => {
    expect(issuePaths(Task, { ...task, input: { type: 'find_people', companyId } })).toContain('input.type');
    expect(issuePaths(Task, { ...task, input: { type: 'profile_company', companyId: id() } })).toContain(
      'input.companyId',
    );
  });
});

describe('Evidence and Finding', () => {
  const evidence = {
    id: id(),
    workspaceId: id(),
    claimId: id(),
    sourceId: id(),
    quote: 'today announced a €12 million Series A round led by Northwind Ventures',
    quoteSha256: hashA,
    grounding: 'normalized',
    spans: [{ start: 120, end: 190 }],
    valueInQuote: true,
    stance: 'supports',
    judge: { verdict: 'supports', reason: 'States the round, amount and lead investor', llmCallId: id() },
    sourcePublishedAt: now,
    sourceRetrievedAt: now,
    extractedByExecutionId: id(),
    createdAt: now,
  };

  it('never sends an ungrounded quote to the judge', () => {
    expect(Evidence.safeParse(evidence).success).toBe(true);
    expect(issuePaths(Evidence, { ...evidence, grounding: 'not_found', spans: [] })).toContain('judge');
  });

  it('does not let a model author a fact', () => {
    const finding = {
      id: id(),
      workspaceId: id(),
      runId: id(),
      subject: { kind: 'run' },
      kind: 'analysis',
      label: 'analysis',
      statement: 'A fresh Series A suggests an active buying window for security tooling.',
      claimRefs: [{ claimId: id(), role: 'basis' }],
      score: null,
      author: { kind: 'model', executionId: id() },
      createdAt: now,
    };
    expect(Finding.safeParse(finding).success).toBe(true);
    expect(issuePaths(Finding, { ...finding, label: 'fact_derived' })).toContain('label');
  });
});

describe('Run', () => {
  it('requires a pause reason when paused, and a brief once running', () => {
    const run = {
      id: id(),
      workspaceId: id(),
      projectId: id(),
      workflow: 'prospect_research',
      workflowVersion: 1,
      objective: 'Find EU cybersecurity startups that raised money recently',
      brief: null,
      status: 'paused',
      pauseReason: null,
      cancelRequested: false,
      pauseRequested: false,
      budgetBlocked: false,
      budget: { maxCostUsdMicros: 2_000_000, maxLlmTokens: 4_000_000, maxToolCalls: 400, maxWallClockSeconds: 3600 },
      spend: { costUsdMicros: 0, llmInputTokens: 0, llmOutputTokens: 0, toolCalls: 0 },
      approvals: { planApprovalId: null, pendingApprovalIds: [] },
      failure: null,
      lastEventSeq: 0,
      createdBy: id(),
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    expect(issuePaths(Run, run)).toEqual(['pauseReason']);
    // Paused while planning is fine without a brief; running is not.
    expect(issuePaths(Run, { ...run, status: 'running' })).toEqual(['brief']);
  });
});

describe('Tool contracts', () => {
  it('applies defaults and rejects unknown keys', () => {
    expect(WebSearchInput.parse({ query: 'cybersecurity series a europe' })).toMatchObject({
      mode: 'general',
      maxResults: 5,
    });
    expect(WebSearchInput.safeParse({ query: 'x y z', fetchEverything: true }).success).toBe(false);
  });

  it('accepts only http(s) URLs for fetching', () => {
    expect(FetchPageInput.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(FetchPageInput.safeParse({ url: 'https://example.com/team' }).success).toBe(true);
  });

  it('models lookups as a discriminated union', () => {
    expect(
      LookupCompanyInput.safeParse({ query: { by: 'registry_id', scheme: 'gb_companies_house', id: '12345678' } })
        .success,
    ).toBe(true);
    expect(LookupCompanyInput.safeParse({ query: { by: 'name' } }).success).toBe(false);
  });

  it('exposes every tool input as a JSON Schema object for MCP', () => {
    for (const contract of Object.values(TOOL_CONTRACTS)) {
      const schema = z.toJSONSchema(contract.input, { io: 'input' }) as { type?: string };
      expect(schema.type).toBe('object');
    }
  });
});

describe('Workflow definitions', () => {
  it('runs agent-loop tasks only with tool-loop agents, and structured tasks with structured agents', () => {
    for (const def of Object.values(TASK_DEFINITIONS)) {
      if (def.kind === 'agent_loop') expect(AGENT_MODES[def.agent]).toBe('tool_loop');
      if (def.kind === 'structured_llm') expect(AGENT_MODES[def.agent]).toBe('structured_call');
      if (def.kind === 'code' || def.kind === 'human_gate') expect(def.agent).toBeNull();
    }
  });

  it('gives tools only to tool-loop agents', () => {
    for (const [agent, tools] of Object.entries(AGENT_TOOLS)) {
      const mode = AGENT_MODES[agent as keyof typeof AGENT_MODES];
      expect(tools.length > 0).toBe(mode === 'tool_loop');
    }
  });
});
