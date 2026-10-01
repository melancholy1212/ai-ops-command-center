/**
 * Runs a verification-scope case (ADR-0009, docs/evaluation.md#verification-cases) through the production code
 * path: the real MCP server in-process with the case's pages, the real scheduler and handlers for discovery,
 * verification and the report. The Research agent is scripted: it opens every page of the case through
 * fetch_page (so snapshots, tiers and injection flags come from the real pipeline) and proposes the case's
 * claims citing the source ids those fetches returned. The verifier is the only model under test; its calls
 * are what --record saves and replay-all replays.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createLogger } from '@aoc/config/logger';
import type { ExecutionId } from '@aoc/contracts';
import { DEFAULT_RUN_BUDGET, createRun, saveBrief } from '@aoc/core';
import { createTasks, lockRun, recomputeRunStatus, settleRun } from '@aoc/core/testing';
import { withWorkspace } from '@aoc/db';
import { createTestHarness } from '@aoc/db/testing';
import {
  createRecordingProvider,
  createReplayProvider,
  createScriptedProvider,
  LlmRouter,
  loadRecordings,
  ROUTES,
  saveRecordings,
  type LlmProvider,
  type LlmResponse,
  type Recording,
  type ScriptedTurn,
  type ToolCallRequest,
} from '@aoc/llm';
import { createHttpHandler, createServices, createTokenVerifier } from '@aoc/mcp-server/eval';
import { connectMcp, createHandlers, createScheduler, createTokenMinter } from '@aoc/worker/eval';
import { exportJWK, generateKeyPair } from 'jose';
import { ToolFixtures, type CaseClaim, type VerificationCase } from './case';
import { fixtureFetcher, fixtureSearch } from './fixtures';
import { collectTrace, type CaseResult } from './metrics';
import { liveProviders, readJson, type RunOptions } from './runner';
import {
  collectVerificationMetrics,
  scoreVerification,
  SCRIPTED_DISCOVERY_ACCOUNT,
  type VerificationMetrics,
} from './verification-metrics';

const NO_SOURCE = '00000000-0000-4000-8000-000000000000';
const usage = { inputTokens: 1, outputTokens: 1, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null };
const respond = (toolCalls: ToolCallRequest[]): LlmResponse => ({
  text: null,
  toolCalls,
  stopReason: 'tool_use',
  usage,
  cacheStatus: 'not_supported',
  providerContent: { role: 'assistant', content: null, tool_calls: toolCalls },
  latencyMs: 1,
  retryCount: 0,
});

/** Opens every page in one turn, then submits the case's claims with the source ids the fetches returned. */
function scriptedDiscovery(claims: readonly CaseClaim[], urls: readonly string[]): LlmProvider {
  return createScriptedProvider(
    [
      () =>
        respond(
          urls.map((url, i) => ({
            id: `open_${String(i)}`,
            name: 'fetch_page',
            argumentsJson: JSON.stringify({ url }),
          })),
        ),
      (request) => {
        const last = request.messages.at(-1);
        if (last?.role !== 'tool') throw new Error('The scripted discovery expected the fetch results.');
        const sourceByUrl = new Map<string, string>();
        for (const result of last.results) {
          const url = urls[Number(result.toolCallId.replace('open_', ''))];
          const output = JSON.parse(result.content) as { sourceId?: unknown };
          if (url && typeof output.sourceId === 'string') sourceByUrl.set(url, output.sourceId);
        }
        const proposed = claims.map((c) => ({
          subject: c.subject,
          assertion: c.assertion,
          rawValue: c.rawValue,
          evidence: c.evidence.map((e) => ({ sourceId: sourceByUrl.get(e.url) ?? NO_SOURCE, quote: e.quote })),
        }));
        return respond([{ id: 'submit', name: 'submit_result', argumentsJson: JSON.stringify({ claims: proposed }) }]);
      },
    ],
    { account: SCRIPTED_DISCOVERY_ACCOUNT },
  );
}

export async function runVerificationCase(evalCase: VerificationCase, options: RunOptions): Promise<CaseResult> {
  const say = options.log ?? (() => undefined);
  const caseDir = join(options.casesDir, evalCase.id);
  const modelPath = join(caseDir, evalCase.fixtures.model);
  const frozen = new Date(evalCase.input.frozenNow);
  const now = () => frozen;
  const log = createLogger('eval', process.env.EVAL_LOG_LEVEL ?? 'silent');
  if (options.mode === 'live')
    throw new Error('Verification cases run on their synthetic pages: replay-all or replay-tools.');

  // Model edge: the verifier only.
  const recordings: Recording[] = [];
  let judges: LlmProvider[];
  if (options.dryJudge) {
    const supportAll = (request: Parameters<Exclude<ScriptedTurn, Partial<LlmResponse>>>[0]): LlmResponse => {
      const first = request.messages[0];
      const items =
        (JSON.parse(first?.role === 'user' ? first.content : '{}') as { items?: { index: number }[] }).items ?? [];
      const text = JSON.stringify({
        verdicts: items.map((i) => ({ index: i.index, verdict: 'supports', reason: 'Dry run: no model consulted.' })),
      });
      return { ...respond([]), text, stopReason: 'end_turn', providerContent: { role: 'assistant', content: text } };
    };
    judges = [
      createScriptedProvider(
        Array.from({ length: 50 }, () => supportAll),
        { account: 'earthruntime' },
      ),
    ];
  } else if (options.mode === 'replay-all') {
    const file = await loadRecordings(modelPath);
    const account = file.recordings[0]?.providerAccount ?? 'earthruntime';
    judges = [createReplayProvider(file, account, account === 'anthropic' ? 'anthropic' : 'openai_compatible')];
  } else {
    judges = liveProviders();
    if (options.record) judges = judges.map((p) => createRecordingProvider(p, recordings));
  }
  const fixtures = ToolFixtures.parse(await readJson(join(caseDir, evalCase.fixtures.tools)));
  const urls = [...new Set(evalCase.input.claims.flatMap((c) => c.evidence.map((e) => e.url)))];

  const harness = await createTestHarness();
  const tenant = await harness.createTenant(`eval-${evalCase.id}`);
  const http = createServer();
  let stopScheduler: (() => Promise<void>) | null = null;
  try {
    // The case's pages are pages the user named: fetchable in the run with a user_provided origin.
    const runId = await createRun(harness.db, { userId: tenant.userId }, tenant.workspaceId, {
      projectId: tenant.projectId,
      objective: evalCase.input.objective,
      budget: DEFAULT_RUN_BUDGET,
      seedUrls: urls,
    });
    const actor = { kind: 'system' } as const;
    await withWorkspace(harness.db, tenant.workspaceId, async (tx) => {
      const run = await lockRun(tx, runId);
      await saveBrief(
        tx,
        run,
        {
          revision: 1,
          objective: evalCase.input.objective,
          criteria: evalCase.input.briefOverride,
          assumptions: [],
          openQuestions: [],
          plannerExecutionId: randomUUID() as ExecutionId,
        },
        actor,
      );
      await createTasks(
        tx,
        run,
        {
          tasks: [
            {
              ref: 'discover',
              type: 'discover_companies',
              input: { type: 'discover_companies' },
              idempotencyKey: 'discover_companies',
            },
          ],
        },
        null,
        'run_start',
        actor,
      );
      await settleRun(tx, run, actor);
      await recomputeRunStatus(tx, run, actor);
    });

    const keys = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const services = createServices({
      db: harness.db,
      log,
      now,
      search: fixtureSearch(fixtures),
      fetcher: fixtureFetcher(fixtures),
    });
    const handler = createHttpHandler({
      verify: await createTokenVerifier(JSON.stringify(await exportJWK(keys.publicKey))),
      services,
      log,
    });
    http.on('request', (req, res) => void handler(req, res));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const mcpUrl = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}/mcp`;

    const router = new LlmRouter({
      providers: [scriptedDiscovery(evalCase.input.claims, urls), ...judges],
      routes: {
        ...ROUTES,
        agent_loop: [
          {
            providerAccount: SCRIPTED_DISCOVERY_ACCOUNT,
            providerKind: 'openai_compatible',
            model: 'gpt-oss-120b',
            reasoning: 'low',
          },
        ],
      },
    });
    const all = createHandlers({
      router,
      mintToken: await createTokenMinter(JSON.stringify(await exportJWK(keys.privateKey))),
      connectTools: (token) => connectMcp(mcpUrl, token),
      now,
    });
    const scheduler = createScheduler({
      db: harness.connect('eval-worker', 8),
      workerId: `eval-${evalCase.id}`,
      handlers: {
        ...(all.discover_companies ? { discover_companies: all.discover_companies } : {}),
        ...(all.verify_entity ? { verify_entity: all.verify_entity } : {}),
        ...(all.compile_report ? { compile_report: all.compile_report } : {}),
      },
      log,
      idlePollMs: 100,
      reapIntervalMs: 3_600_000,
      maxAttemptMs: evalCase.expect.limits.maxWallClockMs,
      retryPolicy: { baseMs: 0, maxMs: 0, jitterMs: 0 },
    });
    stopScheduler = () => scheduler.stop();
    const started = Date.now();
    scheduler.start();
    say(`  ${evalCase.id}: running (${options.mode})`);
    for (;;) {
      const { rows } = await harness.admin.query<{ status: string }>('select status from public.runs where id = $1', [
        runId,
      ]);
      const status = rows[0]?.status;
      if (!status || ['completed', 'failed', 'cancelled', 'paused'].includes(status)) break;
      if (Date.now() - started > evalCase.expect.limits.maxWallClockMs + 30_000) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await scheduler.stop();
    stopScheduler = null;

    const metrics = await collectVerificationMetrics(harness.admin, runId);
    const baseline =
      options.baseline && 'kind' in options.baseline ? (options.baseline as VerificationMetrics) : undefined;
    const failures = scoreVerification(evalCase, metrics, baseline);
    if (options.record && recordings.length > 0)
      await saveRecordings(modelPath, { version: 1, synthetic: evalCase.synthetic, recordings });
    const trace = { trace: await collectTrace(harness.admin, runId) };
    return { caseId: evalCase.id, mode: options.mode, passed: failures.length === 0, failures, metrics, ...trace };
  } finally {
    await stopScheduler?.();
    await new Promise((resolve) => http.close(resolve));
    await harness.close();
  }
}
