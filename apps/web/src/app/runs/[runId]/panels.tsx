import type { Budget, PlanSnapshot } from '@aoc/contracts';
import type { ReactNode } from 'react';
import type { z } from 'zod';
import { StatusBadge } from '@/components/status-badge';
import {
  describeEvent,
  formatCount,
  formatUsd,
  formatUtc,
  humanize,
  leaseState,
  shortHash,
  type StageSummary,
} from '@/lib/run-view';

export function Panel({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-xs font-medium tracking-wide text-ink-subtle uppercase">{title}</h2>
        {aside}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Meter({
  label,
  used,
  limit,
  format,
}: {
  label: string;
  used: number;
  limit: number;
  format: (n: number) => string;
}) {
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const tone = percent >= 100 ? 'bg-danger' : percent >= 80 ? 'bg-warn' : 'bg-accent';
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-ink-muted">{label}</span>
        <span className="font-mono text-ink-subtle">
          {format(used)} of {format(limit)}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded bg-raised"
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={`h-full ${tone}`} style={{ width: `${String(percent)}%` }} />
      </div>
    </div>
  );
}

export function BudgetPanel({
  budget,
  spend,
}: {
  budget: Budget | null;
  spend: { costUsdMicros: number; tokens: number; toolCalls: number };
}) {
  return (
    <Panel title="Budget">
      {budget ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <Meter label="Cost" used={spend.costUsdMicros} limit={budget.maxCostUsdMicros} format={formatUsd} />
          <Meter label="Model tokens" used={spend.tokens} limit={budget.maxLlmTokens} format={formatCount} />
          <Meter label="Tool calls" used={spend.toolCalls} limit={budget.maxToolCalls} format={formatCount} />
        </div>
      ) : (
        <p className="text-sm text-warn">The stored budget could not be read.</p>
      )}
    </Panel>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The stored snapshot, exactly what an approval decides on; never live data (docs/ui.md#approvals). */
export function PlanSnapshotView({ snapshot }: { snapshot: z.infer<typeof PlanSnapshot> }) {
  const c = snapshot.criteria;
  return (
    <div className="space-y-4">
      <dl className="space-y-1.5">
        <Row label="Sector">{c.sectorKeywords.join(', ')}</Row>
        <Row label="Countries">
          <span className="font-mono text-xs">{c.countries.join(' ')}</span>
        </Row>
        <Row label="Funding window">
          {c.fundingWindow.from} to {c.fundingWindow.to}
        </Row>
        <Row label="Stages">{c.fundingStages.length > 0 ? c.fundingStages.join(', ') : 'any'}</Row>
        <Row label="Companies">up to {c.maxCompanies}</Row>
        <Row label="People">{c.peopleRoles.join(', ')}</Row>
        {c.newsOutlets && c.newsOutlets.length > 0 ? (
          <Row label="Searches first">
            <span className="font-mono text-xs">{c.newsOutlets.join(' ')}</span>
          </Row>
        ) : null}
        <Row label="Outreach">
          {c.outreach.enabled ? `up to ${String(c.outreach.maxCompanies)} drafts` : 'disabled'}
        </Row>
        <Row label="Estimate">
          <span className="font-mono text-xs">
            {formatUsd(snapshot.estimate.costUsdMicrosLow)} – {formatUsd(snapshot.estimate.costUsdMicrosHigh)}
          </span>{' '}
          <span className="text-ink-subtle">(budget {formatUsd(snapshot.budget.maxCostUsdMicros)})</span>
        </Row>
      </dl>
      {snapshot.assumptions.length > 0 ? (
        <div>
          <h3 className="text-xs font-medium text-ink-subtle uppercase">Assumptions</h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            {snapshot.assumptions.map((a, i) => (
              <li key={i}>
                <span className="font-mono text-xs text-ink-muted">{a.field}</span>{' '}
                <span className="text-ink">{a.assumed}</span>
                <span className="text-ink-subtle"> — {a.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function ApprovalCard({
  type,
  hash,
  requestedAt,
  children,
}: {
  type: string;
  hash: string;
  requestedAt: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-review/40 bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-medium text-review">
          <span aria-hidden="true">◆ </span>Approval needed: {humanize(type)}
        </h2>
        <span className="font-mono text-[11px] text-ink-subtle">
          snapshot {shortHash(hash)} · requested {formatUtc(requestedAt)}
        </span>
      </div>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}

export function StagePanel({ stages, done, total }: { stages: StageSummary[]; done: number; total: number }) {
  return (
    <Panel
      title="Stages"
      aside={
        <span className="font-mono text-[11px] text-ink-subtle">
          {done} of {total} tasks done
        </span>
      }
    >
      {stages.length === 0 ? (
        <p className="text-sm text-ink-muted">No tasks yet: the run has not been started.</p>
      ) : (
        <ol className="flex flex-wrap items-stretch gap-2">
          {stages.map((stage, i) => (
            <li key={stage.key} className="flex items-center gap-2">
              {i > 0 ? (
                <span aria-hidden="true" className="text-ink-subtle">
                  →
                </span>
              ) : null}
              <div className="min-w-32 rounded-md border border-line bg-raised px-3 py-2">
                <p className="text-sm text-ink">{stage.label}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {stage.counts.map((c) => (
                    <StatusBadge key={c.status} kind="task" status={c.status} note={String(c.count)} />
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

export interface ReportView {
  version: number;
  contentHash: string;
  createdAt: string;
  ranked: {
    rank: number;
    companyId: string;
    name: string;
    total: number | null;
    components: { criterion: string; weight: number; value: number }[];
    claims: number;
    gaps: { attribute: string; reason: string }[];
  }[];
  excluded: { companyId: string; name: string; reason: string }[];
  excludedOmitted: number;
}

export function ReportPanel({ report, runStatus }: { report: ReportView | null; runStatus: string }) {
  if (!report)
    return (
      <Panel title="Report">
        <p className="text-sm text-ink-muted">
          {runStatus === 'completed'
            ? 'No report was saved for this run.'
            : 'No report yet: it is compiled after verification finishes.'}
        </p>
      </Panel>
    );
  return (
    <Panel
      title="Report"
      aside={
        <span className="font-mono text-[11px] text-ink-subtle">
          v{report.version} · {shortHash(report.contentHash)} · {formatUtc(report.createdAt)}
        </span>
      }
    >
      {report.ranked.length === 0 ? (
        <p className="text-sm text-ink-muted">No company met the brief with verified evidence.</p>
      ) : (
        <ol className="space-y-3">
          {report.ranked.map((entry) => (
            <li key={entry.companyId} className="rounded-md border border-line bg-raised p-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm">
                  <span className="font-mono text-ink-subtle">#{entry.rank}</span>{' '}
                  <span className="font-medium text-ink">{entry.name}</span>
                </p>
                <p className="font-mono text-sm text-ink">
                  {entry.total === null ? 'score unreadable' : `${entry.total.toFixed(2)} / 1`}
                </p>
              </div>
              <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                {entry.components.map((c) => (
                  <div key={c.criterion} className="flex items-center gap-2 text-xs">
                    <dt className="w-32 text-ink-muted">{humanize(c.criterion)}</dt>
                    <dd className="flex flex-1 items-center gap-2">
                      <span className="h-1 flex-1 overflow-hidden rounded bg-canvas">
                        <span className="block h-full bg-accent" style={{ width: `${String(c.value * 100)}%` }} />
                      </span>
                      <span className="w-20 text-right font-mono text-ink-subtle">
                        {c.value.toFixed(2)} × {c.weight}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs text-ink-subtle">
                Based on {entry.claims} claims.
                {entry.gaps.length > 0
                  ? ` Unavailable: ${entry.gaps.map((g) => `${humanize(g.attribute)} (${humanize(g.reason)})`).join(', ')}.`
                  : ''}
              </p>
            </li>
          ))}
        </ol>
      )}
      {report.excluded.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-ink-subtle uppercase">Excluded</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {report.excluded.map((e) => (
              <li key={e.companyId}>
                <span className="text-ink">{e.name}</span>
                <span className="text-ink-muted"> — {e.reason}</span>
              </li>
            ))}
          </ul>
          {report.excludedOmitted > 0 ? (
            <p className="mt-1 text-xs text-ink-subtle">and {report.excludedOmitted} more not listed.</p>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

export interface EvidenceView {
  id: string;
  quote: string;
  grounding: string;
  verdict: string | null;
  verdictReason: string | null;
  source: { host: string; url: string; tier: string; type: string; publishedAt: string | null };
}
export interface ClaimView {
  id: string;
  statement: string;
  attribute: string;
  status: string;
  confidence: string | null;
  confidenceScore: number | null;
  reasons: { code: string; detail: string | null }[];
  evidence: EvidenceView[];
}
export interface CompanyClaims {
  companyId: string;
  name: string;
  domain: string | null;
  country: string | null;
  claims: ClaimView[];
}

const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

export function EvidencePanel({ companies }: { companies: CompanyClaims[] }) {
  return (
    <Panel title="Evidence by company">
      {companies.length === 0 ? (
        <p className="text-sm text-ink-muted">No claims yet: discovery has not saved any.</p>
      ) : (
        <div className="space-y-6">
          {companies.map((company) => (
            <div key={company.companyId}>
              <h3 className="text-sm font-medium text-ink">
                {company.name}
                <span className="ml-2 font-mono text-xs font-normal text-ink-subtle">
                  {[company.domain, company.country].filter(Boolean).join(' · ')}
                </span>
              </h3>
              <ul className="mt-2 space-y-3">
                {company.claims.map((claim) => (
                  <li key={claim.id} className="rounded-md border border-line bg-raised p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="text-sm text-ink">{claim.statement}</p>
                      <div className="flex items-center gap-2">
                        <StatusBadge kind="claim" status={claim.status} />
                        <span className="font-mono text-[11px] text-ink-subtle">
                          {claim.confidence
                            ? `${claim.confidence} ${claim.confidenceScore === null ? '' : claim.confidenceScore.toFixed(2)}`
                            : 'no confidence'}
                        </span>
                      </div>
                    </div>
                    {claim.reasons.length > 0 ? (
                      <ul className="mt-1.5 space-y-0.5 text-xs text-ink-muted">
                        {claim.reasons.map((r, i) => (
                          <li key={i}>
                            <span className="font-mono text-ink-subtle">{r.code}</span>
                            {r.detail ? ` ${r.detail}` : ''}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <ul className="mt-2 space-y-2">
                      {claim.evidence.map((e) => (
                        <li key={e.id} className="border-l-2 border-line pl-3">
                          <blockquote className="text-sm text-ink-muted">“{e.quote}”</blockquote>
                          <p className="mt-1 font-mono text-[11px] text-ink-subtle">
                            grounding {humanize(e.grounding)} · judge {e.verdict ?? 'not judged'}
                            {e.verdictReason ? ` (${e.verdictReason})` : ''}
                          </p>
                          <p className="font-mono text-[11px] text-ink-subtle">
                            {isWebUrl(e.source.url) ? (
                              <a
                                href={e.source.url}
                                target="_blank"
                                rel="noopener noreferrer nofollow"
                                className="text-accent hover:underline"
                              >
                                {e.source.host}
                              </a>
                            ) : (
                              e.source.host
                            )}{' '}
                            · tier {e.source.tier} · {humanize(e.source.type)}
                            {e.source.publishedAt ? ` · published ${e.source.publishedAt.slice(0, 10)}` : ''}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export interface TaskView {
  id: string;
  type: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  company: string | null;
  leaseExpiresAt: string | null;
  failureCode: string | null;
  updatedAt: string;
}

export function TaskTable({ tasks, now }: { tasks: TaskView[]; now: Date }) {
  return (
    <Panel title="Tasks">
      {tasks.length === 0 ? (
        <p className="text-sm text-ink-muted">No tasks yet: the run has not been started.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-subtle">
              <tr className="border-b border-line">
                <th className="py-1.5 pr-3 font-medium">Task</th>
                <th className="py-1.5 pr-3 font-medium">Company</th>
                <th className="py-1.5 pr-3 font-medium">Status</th>
                <th className="py-1.5 pr-3 font-medium">Attempts</th>
                <th className="py-1.5 pr-3 font-medium">Last failure</th>
                <th className="py-1.5 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const lease = leaseState({ status: t.status, lease_expires_at: t.leaseExpiresAt }, now);
                return (
                  <tr key={t.id} className="border-b border-line last:border-0">
                    <td className="py-1.5 pr-3 text-ink">{humanize(t.type)}</td>
                    <td className="py-1.5 pr-3 text-ink-muted">{t.company ?? '—'}</td>
                    <td className="py-1.5 pr-3">
                      <StatusBadge
                        kind="task"
                        status={t.status}
                        note={lease === 'live' ? 'lease live' : lease === 'expired' ? 'lease expired' : undefined}
                      />
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-xs text-ink-muted">
                      {t.attempt} / {t.maxAttempts}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-xs text-danger">{t.failureCode ?? ''}</td>
                    <td className="py-1.5 font-mono text-xs whitespace-nowrap text-ink-subtle">
                      {formatUtc(t.updatedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function ActivityPanel({
  events,
}: {
  events: { seq: number; type: string; data: unknown; occurredAt: string }[];
}) {
  return (
    <Panel title="Activity" aside={<span className="font-mono text-[11px] text-ink-subtle">latest 40 events</span>}>
      {events.length === 0 ? (
        <p className="text-sm text-ink-muted">No events yet.</p>
      ) : (
        <ol className="space-y-1">
          {events.map((e) => (
            <li key={e.seq} className="grid grid-cols-[3rem_11rem_1fr] gap-2 text-xs">
              <span className="font-mono text-ink-subtle">#{e.seq}</span>
              <span className="font-mono text-ink-subtle">{formatUtc(e.occurredAt)}</span>
              <span className="text-ink-muted">{describeEvent(e.type, e.data)}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
