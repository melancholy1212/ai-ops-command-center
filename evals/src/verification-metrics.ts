/**
 * Metrics and gates for verification-scope cases: what grounding, the verifier, policy, confidence and the
 * report decided, read from the run's own rows (the same data the UI shows). The scripted discovery's own
 * model turns are excluded from model-call counts and cost: only the verifier is being measured.
 */
import type pg from 'pg';
import type { VerificationCase } from './case';

export const SCRIPTED_DISCOVERY_ACCOUNT = 'scripted-discovery';

export interface VerificationMetrics {
  kind: 'verification';
  runStatus: string;
  failedTasks: string[];
  companies: string[];
  claims: {
    company: string;
    attribute: string;
    statement: string;
    status: string;
    confidence: string | null;
    confidenceScore: number | null;
    reasons: string[];
  }[];
  report: { ranked: string[]; excluded: { company: string; reason: string }[] } | null;
  flaggedHosts: string[];
  judgeVerdicts: Record<string, number>;
  llmCalls: number;
  costUsdMicros: number;
  inputTokens: number;
  outputTokens: number;
}

export async function collectVerificationMetrics(admin: pg.Client, runId: string): Promise<VerificationMetrics> {
  const run = (await admin.query<{ status: string }>('select status from public.runs where id = $1', [runId])).rows[0];
  const failed = (
    await admin.query<{ type: string; code: string | null }>(
      `select type, last_failure ->> 'code' as code from public.tasks where run_id = $1 and status = 'failed'`,
      [runId],
    )
  ).rows;
  const companies = (
    await admin.query<{ id: string; name: string }>(
      `select distinct co.id, co.name from public.companies co
       join public.claims c on c.subject_company_id = co.id where c.run_id = $1 order by co.name`,
      [runId],
    )
  ).rows;
  const names = new Map(companies.map((c) => [c.id, c.name]));
  const claims = (
    await admin.query<{
      company: string;
      attribute: string;
      statement: string;
      status: string;
      confidence: string | null;
      confidence_score: string | null;
      reasons: string[] | null;
    }>(
      `select co.name as company, c.attribute, c.statement, c.status, c.confidence, c.confidence_score::text,
              (select array_agg(r ->> 'code') from jsonb_array_elements(c.verification -> 'reasons') r) as reasons
       from public.claims c join public.companies co on co.id = c.subject_company_id
       where c.run_id = $1 order by co.name, c.attribute, c.statement`,
      [runId],
    )
  ).rows;
  const artifact = (
    await admin.query<{
      content: { companies: { companyId: string; rank: number }[]; excluded: { companyId: string; reason: string }[] };
    }>(
      `select content from public.artifacts where run_id = $1 and kind = 'prospect_report' and status = 'final'
       order by version desc limit 1`,
      [runId],
    )
  ).rows[0];
  const flagged = (
    await admin.query<{ host: string }>(
      `select distinct s.host from public.sources s
       where s.id in (select unnest(created_source_ids) from public.tool_calls where run_id = $1)
         and 'suspected_prompt_injection' = any(s.flags) order by s.host`,
      [runId],
    )
  ).rows;
  const verdicts = (
    await admin.query<{ verdict: string; n: number }>(
      `select e.judge_verdict as verdict, count(*)::int as n from public.evidence e
       join public.claims c on c.id = e.claim_id where c.run_id = $1 and e.judge_verdict is not null
       group by e.judge_verdict order by e.judge_verdict`,
      [runId],
    )
  ).rows;
  const llm = (
    await admin.query<{ n: number; cost: string; input: string; output: string }>(
      `select count(*)::int as n, coalesce(sum(cost_usd_micros), 0) as cost,
              coalesce(sum(input_tokens), 0) as input, coalesce(sum(output_tokens), 0) as output
       from public.llm_calls where run_id = $1 and provider_account <> $2`,
      [runId, SCRIPTED_DISCOVERY_ACCOUNT],
    )
  ).rows[0];
  return {
    kind: 'verification',
    runStatus: run?.status ?? 'missing',
    failedTasks: failed.map((t) => `${t.type}: ${t.code ?? 'unknown'}`),
    companies: companies.map((c) => c.name),
    claims: claims.map((c) => ({
      company: c.company,
      attribute: c.attribute,
      statement: c.statement,
      status: c.status,
      confidence: c.confidence,
      confidenceScore: c.confidence_score === null ? null : Number(c.confidence_score),
      reasons: c.reasons ?? [],
    })),
    report: artifact
      ? {
          ranked: [...artifact.content.companies]
            .sort((a, b) => a.rank - b.rank)
            .map((c) => names.get(c.companyId) ?? c.companyId),
          excluded: artifact.content.excluded.map((e) => ({
            company: names.get(e.companyId) ?? e.companyId,
            reason: e.reason,
          })),
        }
      : null,
    flaggedHosts: flagged.map((f) => f.host),
    judgeVerdicts: Object.fromEntries(verdicts.map((v) => [v.verdict, v.n])),
    llmCalls: llm?.n ?? 0,
    costUsdMicros: Number(llm?.cost ?? 0),
    inputTokens: Number(llm?.input ?? 0),
    outputTokens: Number(llm?.output ?? 0),
  };
}

/** The gates. Every failure names what differed, so a red case says exactly what regressed. */
export function scoreVerification(
  evalCase: VerificationCase,
  metrics: VerificationMetrics,
  baseline?: VerificationMetrics,
): string[] {
  const failures: string[] = [];
  const { expect } = evalCase;
  if (metrics.runStatus !== 'completed') failures.push(`run ${metrics.runStatus}, expected completed`);
  for (const task of metrics.failedTasks) failures.push(`task failed: ${task}`);

  const companies = [...metrics.companies].sort();
  const wanted = [...expect.companies].sort();
  if (JSON.stringify(companies) !== JSON.stringify(wanted))
    failures.push(`companies ${JSON.stringify(companies)}, expected ${JSON.stringify(wanted)}`);

  for (const e of expect.claims) {
    const label = `${e.company} ${e.attribute}${e.statementIncludes ? ` "${e.statementIncludes}"` : ''}`;
    const found = metrics.claims.filter(
      (c) =>
        c.company === e.company &&
        c.attribute === e.attribute &&
        (e.statementIncludes === undefined || c.statement.includes(e.statementIncludes)),
    );
    if (found.length !== 1) {
      failures.push(`${label}: ${String(found.length)} matching claims, expected 1`);
      continue;
    }
    const claim = found[0];
    if (!claim) continue;
    if (claim.status !== e.status) failures.push(`${label}: status ${claim.status}, expected ${e.status}`);
    if (e.confidence !== undefined && claim.confidence !== e.confidence)
      failures.push(`${label}: confidence ${String(claim.confidence)}, expected ${String(e.confidence)}`);
    if (e.confidenceScore !== undefined && claim.confidenceScore !== e.confidenceScore)
      failures.push(
        `${label}: confidence score ${String(claim.confidenceScore)}, expected ${String(e.confidenceScore)}`,
      );
    for (const code of e.reasonsInclude)
      if (!claim.reasons.includes(code))
        failures.push(`${label}: reason ${code} missing (has ${claim.reasons.join(', ')})`);
    for (const code of e.reasonsExclude)
      if (claim.reasons.includes(code)) failures.push(`${label}: unexpected reason ${code}`);
  }

  if (!metrics.report) failures.push('no final report');
  else {
    if (JSON.stringify(metrics.report.ranked) !== JSON.stringify(expect.report.ranked))
      failures.push(
        `ranked ${JSON.stringify(metrics.report.ranked)}, expected ${JSON.stringify(expect.report.ranked)}`,
      );
    if (metrics.report.excluded.length !== expect.report.excluded.length)
      failures.push(
        `${String(metrics.report.excluded.length)} excluded, expected ${String(expect.report.excluded.length)}`,
      );
    for (const e of expect.report.excluded) {
      const hit = metrics.report.excluded.find((x) => x.company === e.company);
      if (!hit) failures.push(`${e.company} not excluded`);
      else if (!hit.reason.includes(e.reasonIncludes))
        failures.push(`${e.company} excluded for "${hit.reason}", expected "${e.reasonIncludes}"`);
    }
  }

  for (const host of expect.flaggedHosts)
    if (!metrics.flaggedHosts.includes(host)) failures.push(`snapshot from ${host} not flagged as suspected injection`);
  if (metrics.costUsdMicros > expect.limits.maxCostUsdMicros)
    failures.push(`cost ${String(metrics.costUsdMicros)} > limit ${String(expect.limits.maxCostUsdMicros)}`);
  if (metrics.llmCalls > expect.limits.maxLlmCalls)
    failures.push(`model calls ${String(metrics.llmCalls)} > limit ${String(expect.limits.maxLlmCalls)}`);
  if (baseline && metrics.costUsdMicros > baseline.costUsdMicros * 1.2)
    failures.push(
      `cost regressed: ${String(metrics.costUsdMicros)} > baseline ${String(baseline.costUsdMicros)} + 20%`,
    );
  return failures;
}
