import { Budget, PlanSnapshot, ReportContent } from '@aoc/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { AutoRefresh } from '@/components/auto-refresh';
import { ConsoleShell } from '@/components/console-shell';
import { StatusBadge } from '@/components/status-badge';
import {
  formatDuration,
  formatUtc,
  humanize,
  isRunActive,
  stageSummaries,
  taskProgress,
  TERMINAL_RUN_STATUSES,
} from '@/lib/run-view';
import { requireUser } from '@/lib/server/session';
import { DecisionForm } from './decision-form';
import {
  ActivityPanel,
  ApprovalCard,
  BudgetPanel,
  EvidencePanel,
  PlanSnapshotView,
  ReportPanel,
  StagePanel,
  TaskTable,
  type CompanyClaims,
  type ReportView,
} from './panels';
import { RunControls } from './run-controls';

export const metadata: Metadata = { title: 'Research run' };

const Reasons = z.object({
  reasons: z.array(z.object({ code: z.string(), detail: z.string().nullish() })).catch([]),
});
const Score = z.object({
  total: z.number(),
  components: z.array(z.object({ criterion: z.string(), weight: z.number(), value: z.number() })),
});
const Failure = z.object({ code: z.string(), message: z.string().optional() });
const CLAIM_ORDER = ['verified', 'probable', 'contested', 'grounded', 'proposed', 'stale', 'rejected'];

export default async function RunPage({ params }: PageProps<'/runs/[runId]'>) {
  const { runId } = await params;
  if (!z.uuid().safeParse(runId).success) notFound();
  const session = await requireUser();
  const db = session.supabase;

  // Everything below is read as the signed-in user: row-level security returns nothing for other workspaces.
  const { data: run } = await db.from('runs').select('*, project:projects(name)').eq('id', runId).maybeSingle();
  if (!run) notFound();
  const now = new Date();

  const [tasks, approvals, events, claims, gaps, report] = await Promise.all([
    db
      .from('tasks')
      .select('id, type, status, attempt, max_attempts, subject_company_id, lease_expires_at, last_failure, updated_at')
      .eq('run_id', runId)
      .order('created_at')
      .order('idempotency_key'),
    db
      .from('approvals')
      .select('id, type, snapshot, snapshot_hash, requested_at')
      .eq('run_id', runId)
      .eq('status', 'pending')
      .order('requested_at'),
    db
      .from('run_events')
      .select('seq, type, data, occurred_at')
      .eq('run_id', runId)
      .order('seq', { ascending: false })
      .limit(40),
    db
      .from('claims')
      .select(
        'id, subject_company_id, attribute, statement, status, confidence, confidence_score, verification, evidence(id, quote, grounding, judge_verdict, judge_reason, source:sources(host, final_url, tier, source_type, published_at))',
      )
      .eq('run_id', runId)
      .order('created_at'),
    db.from('research_gaps').select('company_id, attribute, reason, status').eq('run_id', runId),
    db
      .from('artifacts')
      .select('version, content, content_hash, created_at')
      .eq('run_id', runId)
      .eq('kind', 'prospect_report')
      .eq('status', 'final')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const loadFailed = [tasks, approvals, events, claims, gaps, report].some((r) => r.error);

  const companyIds = [
    ...new Set([
      ...(claims.data ?? []).map((c) => c.subject_company_id),
      ...(tasks.data ?? []).flatMap((t) => (t.subject_company_id ? [t.subject_company_id] : [])),
    ]),
  ];
  const { data: companies } =
    companyIds.length > 0
      ? await db.from('companies').select('id, name, primary_domain, country').in('id', companyIds)
      : { data: [] };
  const companyById = new Map((companies ?? []).map((c) => [c.id, c]));
  const nameOf = (id: string) => companyById.get(id)?.name ?? 'Unknown company';

  // The report, validated against its contract; the score findings it points at, validated too.
  let reportView: ReportView | null = null;
  const parsedReport = report.data ? ReportContent.safeParse(report.data.content) : null;
  if (report.data && parsedReport?.success) {
    const content = parsedReport.data;
    const { data: findings } = await db
      .from('findings')
      .select('id, score')
      .in(
        'id',
        content.companies.map((c) => c.scoreFindingId),
      );
    const scoreOf = new Map((findings ?? []).map((f) => [f.id, Score.safeParse(f.score)]));
    reportView = {
      version: report.data.version,
      contentHash: report.data.content_hash,
      createdAt: report.data.created_at,
      ranked: content.companies.map((c) => {
        const score = scoreOf.get(c.scoreFindingId);
        return {
          rank: c.rank,
          companyId: c.companyId,
          name: nameOf(c.companyId),
          total: score?.success ? score.data.total : null,
          components: score?.success ? score.data.components : [],
          claims: c.claimIds.length,
          gaps: (gaps.data ?? [])
            .filter((g) => g.company_id === c.companyId && g.status === 'unavailable')
            .map((g) => ({ attribute: g.attribute, reason: g.reason })),
        };
      }),
      excluded: content.excluded.map((e) => ({ companyId: e.companyId, name: nameOf(e.companyId), reason: e.reason })),
      excludedOmitted: content.excludedOmitted,
    };
  }

  // Claims by company: companies in report order first, then by name.
  const rankOf = new Map(reportView?.ranked.map((r) => [r.companyId, r.rank]) ?? []);
  const grouped: CompanyClaims[] = [...new Set((claims.data ?? []).map((c) => c.subject_company_id))]
    .map((companyId) => ({
      companyId,
      name: nameOf(companyId),
      domain: companyById.get(companyId)?.primary_domain ?? null,
      country: companyById.get(companyId)?.country ?? null,
      claims: (claims.data ?? [])
        .filter((c) => c.subject_company_id === companyId)
        .sort((a, b) => CLAIM_ORDER.indexOf(a.status) - CLAIM_ORDER.indexOf(b.status))
        .map((c) => ({
          id: c.id,
          statement: c.statement,
          attribute: c.attribute,
          status: c.status,
          confidence: c.confidence,
          confidenceScore: c.confidence_score,
          reasons: (Reasons.safeParse(c.verification).data?.reasons ?? []).map((r) => ({
            code: r.code,
            detail: r.detail ?? null,
          })),
          evidence: c.evidence.map((e) => ({
            id: e.id,
            quote: e.quote,
            grounding: e.grounding,
            verdict: e.judge_verdict,
            verdictReason: e.judge_reason,
            source: {
              host: e.source.host,
              url: e.source.final_url,
              tier: e.source.tier,
              type: e.source.source_type,
              publishedAt: e.source.published_at,
            },
          })),
        })),
    }))
    .sort(
      (a, b) =>
        (rankOf.get(a.companyId) ?? Infinity) - (rankOf.get(b.companyId) ?? Infinity) || a.name.localeCompare(b.name),
    );

  const taskRows = tasks.data ?? [];
  const progress = taskProgress(taskRows);
  const budget = Budget.safeParse(run.budget);
  const failure = run.failure ? Failure.safeParse(run.failure) : null;
  const elapsedMs = run.started_at
    ? (run.finished_at ? Date.parse(run.finished_at) : now.getTime()) - Date.parse(run.started_at)
    : null;

  return (
    <ConsoleShell active="Runs" session={session}>
      <nav className="text-xs text-ink-subtle">
        <Link href="/runs" className="hover:text-ink">
          Runs
        </Link>{' '}
        / <span className="font-mono">{run.id.slice(0, 8)}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-3">
            <p className="font-mono text-[11px] tracking-[0.18em] text-accent-cyan uppercase">Research run</p>
            <StatusBadge
              kind="run"
              status={run.status}
              note={run.pause_reason ? humanize(run.pause_reason) : undefined}
            />
          </div>
          <h1 className="max-w-3xl text-lg font-medium text-ink">{run.objective}</h1>
          <p className="font-mono text-[11px] text-ink-subtle">
            {run.project.name} · workflow v{run.workflow_version} · created {formatUtc(run.created_at)}
            {elapsedMs === null
              ? ' · not started'
              : ` · ${run.finished_at ? 'took' : 'running for'} ${formatDuration(elapsedMs)}`}
          </p>
          <AutoRefresh active={isRunActive(run.status)} readAt={formatUtc(now)} />
        </div>
        <RunControls
          runId={run.id}
          canStart={run.status === 'draft'}
          canCancel={!TERMINAL_RUN_STATUSES.has(run.status) && run.status !== 'draft'}
        />
      </header>

      {loadFailed ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          Part of this run could not be loaded; what is shown may be incomplete. Reload to try again.
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          The run failed:{' '}
          {failure.success
            ? `${failure.data.code}${failure.data.message ? ` — ${failure.data.message}` : ''}`
            : 'the failure record could not be read.'}
        </p>
      ) : null}

      {(approvals.data ?? []).map((approval) => {
        const plan = approval.type === 'plan' ? PlanSnapshot.safeParse(approval.snapshot) : null;
        return (
          <ApprovalCard
            key={approval.id}
            type={approval.type}
            hash={approval.snapshot_hash}
            requestedAt={approval.requested_at}
          >
            {plan === null ? (
              <pre className="max-h-64 overflow-auto rounded bg-canvas p-3 font-mono text-xs text-ink-muted">
                {JSON.stringify(approval.snapshot, null, 2)}
              </pre>
            ) : plan.success ? (
              <PlanSnapshotView snapshot={plan.data} />
            ) : null}
            {plan !== null && !plan.success ? (
              <p className="text-sm text-danger">
                The stored plan could not be read, so it cannot be approved here. Cancel the run or contact support.
              </p>
            ) : (
              <DecisionForm approvalId={approval.id} snapshotHash={approval.snapshot_hash} />
            )}
          </ApprovalCard>
        );
      })}

      <BudgetPanel
        budget={budget.success ? budget.data : null}
        spend={{
          costUsdMicros: run.spend_cost_usd_micros,
          tokens: run.spend_llm_input_tokens + run.spend_llm_output_tokens,
          toolCalls: run.spend_tool_calls,
        }}
      />
      <StagePanel stages={stageSummaries(taskRows)} done={progress.done} total={progress.total} />
      {report.data && !parsedReport?.success ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          The saved report could not be read.
        </p>
      ) : (
        <ReportPanel report={reportView} runStatus={run.status} />
      )}
      <EvidencePanel companies={grouped} />
      <TaskTable
        now={now}
        tasks={taskRows.map((t) => ({
          id: t.id,
          type: t.type,
          status: t.status,
          attempt: t.attempt,
          maxAttempts: t.max_attempts,
          company: t.subject_company_id ? nameOf(t.subject_company_id) : null,
          leaseExpiresAt: t.lease_expires_at,
          failureCode: t.last_failure ? (Failure.safeParse(t.last_failure).data?.code ?? 'unreadable') : null,
          updatedAt: t.updated_at,
        }))}
      />
      <ActivityPanel
        events={(events.data ?? []).map((e) => ({ seq: e.seq, type: e.type, data: e.data, occurredAt: e.occurred_at }))}
      />
    </ConsoleShell>
  );
}
