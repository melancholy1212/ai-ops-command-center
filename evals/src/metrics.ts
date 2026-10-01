/**
 * Metrics from the run's own rows, the same data the UI shows (docs/evaluation.md#metrics), and the gates a
 * case must pass.
 */
import type pg from 'pg';
import type { DiscoveryCase } from './case';
import type { VerificationMetrics } from './verification-metrics';

export interface CaseMetrics {
  taskStatus: string;
  taskFailure: string | null;
  executionStatus: string | null;
  turns: number;
  llmCalls: number;
  toolCalls: number;
  toolErrors: Record<string, number>;
  costUsdMicros: number;
  inputTokens: number;
  outputTokens: number;
  sources: number;
  sourceHosts: string[];
  flaggedSources: number;
  claimsProposed: number;
  companiesProposed: string[];
  expectedFound: string[];
  expectedMissing: string[];
  forbiddenProposed: string[];
  forbiddenHostsFetched: string[];
  /** Cited quotes found in their source's saved text after whitespace and case normalisation (tracked, not gated). */
  quoteMatchRate: number | null;
  /** Production grounding of every saved quote (exact, normalized, elided_segments, not_found): tracked, not gated. */
  grounding: Record<string, number>;
  /** Share of saved quotes that grounded (anything but not_found). */
  groundedQuoteRate: number | null;
}

export interface CaseResult {
  caseId: string;
  mode: string;
  passed: boolean;
  failures: string[];
  metrics: CaseMetrics | VerificationMetrics;
  /** The run's trace: what the agent did, what it read, what it proposed. */
  trace?: unknown;
}

/** The whole execution as recorded, for inspecting a live run: tool calls, sources, model calls, claims. */
export async function collectTrace(admin: pg.Client, runId: string) {
  const toolCalls = await admin.query(
    `select started_at, tool, arguments, status, error_code, provider, cache_hit, latency_ms, cost_usd_micros
     from public.tool_calls where run_id = $1 order by started_at`,
    [runId],
  );
  const sources = await admin.query(
    `select s.final_url, s.title, s.tier, s.source_type, s.flags, s.text_length, s.published_at, s.origin ->> 'kind' as origin
     from public.sources s where s.id in (select unnest(created_source_ids) from public.tool_calls where run_id = $1)
     order by s.created_at`,
    [runId],
  );
  const llmCalls = await admin.query(
    `select seq, provider_account, model, route, input_tokens, output_tokens, cost_usd_micros, latency_ms, retry_count, stop_reason
     from public.llm_calls where run_id = $1 order by seq`,
    [runId],
  );
  const execution = await admin.query('select status, output, failure from public.agent_executions where run_id = $1', [
    runId,
  ]);
  const messages = await admin.query(
    `select m.seq, m.role, m.content from public.agent_messages m
     join public.agent_executions e on e.id = m.execution_id where e.run_id = $1 order by e.started_at, m.seq`,
    [runId],
  );
  return {
    toolCalls: toolCalls.rows,
    sources: sources.rows,
    llmCalls: llmCalls.rows,
    executions: execution.rows,
    messages: messages.rows,
  };
}

interface ProposedClaim {
  subject: { kind: string; name?: string };
  evidence: { sourceId: string; quote: string }[];
}

const loose = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
const matches = (a: string, b: string) => loose(a).includes(loose(b)) || loose(b).includes(loose(a));

export async function collectMetrics(admin: pg.Client, runId: string, evalCase: DiscoveryCase): Promise<CaseMetrics> {
  const task = (
    await admin.query<{ status: string; last_failure: { code: string; message: string } | null }>(
      `select status, last_failure from public.tasks where run_id = $1 and type = 'discover_companies'`,
      [runId],
    )
  ).rows[0];
  const executions = (
    await admin.query<{ status: string; output: { claims: ProposedClaim[] } | null; turns: number }>(
      'select status, output, turns from public.agent_executions where run_id = $1 order by started_at',
      [runId],
    )
  ).rows;
  const last = executions.at(-1);
  const llm = (
    await admin.query<{ n: number; cost: string; input: string; output: string }>(
      `select count(*)::int as n, coalesce(sum(cost_usd_micros), 0) as cost,
            coalesce(sum(input_tokens + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0)), 0) as input,
            coalesce(sum(output_tokens), 0) as output
     from public.llm_calls where run_id = $1`,
      [runId],
    )
  ).rows[0];
  const tools = (
    await admin.query<{ status: string; error_code: string | null; cost: string }>(
      'select status, error_code, cost_usd_micros as cost from public.tool_calls where run_id = $1',
      [runId],
    )
  ).rows;
  const sources = (
    await admin.query<{ id: string; host: string; text: string; flags: string[] }>(
      `select s.id, s.host, s.text, s.flags from public.sources s
     where s.id in (select unnest(created_source_ids) from public.tool_calls where run_id = $1)`,
      [runId],
    )
  ).rows;

  const evidence = (
    await admin.query<{ grounding: string; n: number }>(
      `select e.grounding, count(*)::int as n from public.evidence e join public.claims c on c.id = e.claim_id
       where c.run_id = $1 group by e.grounding order by e.grounding`,
      [runId],
    )
  ).rows;
  const grounding = Object.fromEntries(evidence.map((r) => [r.grounding, r.n]));
  const savedQuotes = evidence.reduce((sum, r) => sum + r.n, 0);

  const claims = last?.output?.claims ?? [];
  const companies = [
    ...new Set(claims.filter((c) => c.subject.kind === 'new_company').map((c) => c.subject.name ?? '')),
  ];
  const toolErrors: Record<string, number> = {};
  for (const t of tools) if (t.error_code) toolErrors[t.error_code] = (toolErrors[t.error_code] ?? 0) + 1;
  const textById = new Map(sources.map((s) => [s.id, loose(s.text)]));
  const quotes = claims.flatMap((c) => c.evidence);
  const found = quotes.filter(
    (e) => textById.get(e.sourceId)?.includes(loose(e.quote.replace(/^["\u201c]|["\u201d]$/g, ''))) === true,
  );

  return {
    taskStatus: task?.status ?? 'missing',
    taskFailure: task?.last_failure ? `${task.last_failure.code}: ${task.last_failure.message.slice(0, 200)}` : null,
    executionStatus: last?.status ?? null,
    turns: last?.turns ?? 0,
    llmCalls: llm?.n ?? 0,
    toolCalls: tools.length,
    toolErrors,
    costUsdMicros: Number(llm?.cost ?? 0) + tools.reduce((sum, t) => sum + Number(t.cost), 0),
    inputTokens: Number(llm?.input ?? 0),
    outputTokens: Number(llm?.output ?? 0),
    sources: sources.length,
    sourceHosts: [...new Set(sources.map((s) => s.host))].sort(),
    flaggedSources: sources.filter((s) => s.flags.includes('suspected_prompt_injection')).length,
    claimsProposed: claims.length,
    companiesProposed: companies.sort(),
    expectedFound: evalCase.expect.companies.filter((name) => companies.some((c) => matches(c, name))),
    expectedMissing: evalCase.expect.companies.filter((name) => !companies.some((c) => matches(c, name))),
    forbiddenProposed: evalCase.expect.forbiddenCompanies
      .filter((f) => companies.some((c) => matches(c, f.name)))
      .map((f) => f.name),
    forbiddenHostsFetched: evalCase.expect.forbiddenHosts.filter((host) => sources.some((s) => s.host === host)),
    quoteMatchRate: quotes.length > 0 ? Number((found.length / quotes.length).toFixed(3)) : null,
    grounding,
    groundedQuoteRate:
      savedQuotes > 0 ? Number(((savedQuotes - (grounding.not_found ?? 0)) / savedQuotes).toFixed(3)) : null,
  };
}

/** The gates. Every failure is named, so a red result says exactly what regressed. */
export function score(evalCase: DiscoveryCase, metrics: CaseMetrics, baseline?: CaseMetrics): string[] {
  const failures: string[] = [];
  const { limits } = evalCase.expect;
  if (metrics.taskStatus !== 'succeeded')
    failures.push(`discovery task ${metrics.taskStatus}${metrics.taskFailure ? ` (${metrics.taskFailure})` : ''}`);
  for (const name of metrics.expectedMissing) failures.push(`expected company not proposed: ${name}`);
  for (const name of metrics.forbiddenProposed) failures.push(`forbidden company proposed: ${name}`);
  for (const host of metrics.forbiddenHostsFetched) failures.push(`source saved from forbidden host: ${host}`);
  if (metrics.costUsdMicros > limits.maxCostUsdMicros)
    failures.push(`cost ${String(metrics.costUsdMicros)} > limit ${String(limits.maxCostUsdMicros)}`);
  if (metrics.llmCalls > limits.maxLlmCalls)
    failures.push(`model calls ${String(metrics.llmCalls)} > limit ${String(limits.maxLlmCalls)}`);
  if (metrics.toolCalls > limits.maxToolCalls)
    failures.push(`tool calls ${String(metrics.toolCalls)} > limit ${String(limits.maxToolCalls)}`);
  if (baseline) {
    if (metrics.expectedFound.length < baseline.expectedFound.length) {
      failures.push(
        `coverage regressed: ${String(metrics.expectedFound.length)} < baseline ${String(baseline.expectedFound.length)}`,
      );
    }
    if (metrics.costUsdMicros > baseline.costUsdMicros * 1.2) {
      failures.push(
        `cost regressed: ${String(metrics.costUsdMicros)} > baseline ${String(baseline.costUsdMicros)} + 20%`,
      );
    }
  }
  return failures;
}
