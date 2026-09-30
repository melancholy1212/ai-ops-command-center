/**
 * Runs one eval case through the production code path (ADR-0009): a throwaway tenant in the local
 * database, a run with the case's brief and one discover_companies task, the real MCP server in-process
 * over HTTP with real capability tokens, and the real scheduler, handler and tool loop. Only the edges are
 * replayed: search and page fetches at the MCP server's provider layer, and model responses.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '@aoc/config/logger';
import { DEFAULT_RUN_BUDGET, createRun, saveBrief } from '@aoc/core';
import { createTasks, lockRun, recomputeRunStatus, settleRun } from '@aoc/core/testing';
import type { ExecutionId } from '@aoc/contracts';
import { withWorkspace } from '@aoc/db';
import { createTestHarness } from '@aoc/db/testing';
import {
  createOpenAiCompatibleProvider,
  createAnthropicProvider,
  createRecordingProvider,
  createReplayProvider,
  LlmRouter,
  loadRecordings,
  saveRecordings,
  type LlmProvider,
  type Recording,
} from '@aoc/llm';
import {
  createHttpHandler,
  createServices,
  createTokenVerifier,
  type PageFetcher,
  type SearchProvider,
} from '@aoc/mcp-server/eval';
import { connectMcp, createHandlers, createScheduler, createTokenMinter } from '@aoc/worker/eval';
import { exportJWK, generateKeyPair } from 'jose';
import { ToolFixtures, type EvalCase, type EvalMode } from './case';
import { fixtureFetcher, fixtureSearch, recordingEdges } from './fixtures';
import { collectMetrics, collectTrace, score, type CaseResult } from './metrics';

export interface RunOptions {
  mode: EvalMode;
  /** Save what the live edges returned as the case's fixtures. */
  record: boolean;
  casesDir: string;
  baseline?: CaseResult['metrics'];
  log?: (line: string) => void;
}

function liveProviders(): LlmProvider[] {
  const providers: LlmProvider[] = [];
  if (process.env.ANTHROPIC_API_KEY) providers.push(createAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }));
  if (process.env.EARTHRUNTIME_API_KEY) {
    providers.push(
      createOpenAiCompatibleProvider({
        apiKey: process.env.EARTHRUNTIME_API_KEY,
        baseURL: process.env.EARTHRUNTIME_BASE_URL ?? 'https://api.earthruntime.com/v1',
        account: 'earthruntime',
      }),
    );
  }
  if (providers.length === 0)
    throw new Error('No model provider configured: set EARTHRUNTIME_API_KEY or ANTHROPIC_API_KEY');
  return providers;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function runCase(evalCase: EvalCase, options: RunOptions): Promise<CaseResult> {
  const say = options.log ?? (() => undefined);
  const caseDir = join(options.casesDir, evalCase.id);
  const toolsPath = join(caseDir, evalCase.fixtures.tools);
  const modelPath = join(caseDir, evalCase.fixtures.model);
  const frozen = options.mode === 'live' ? new Date() : new Date(evalCase.input.frozenNow);
  const now = () => frozen;
  const log = createLogger('eval', process.env.EVAL_LOG_LEVEL ?? 'silent');

  // Model edge.
  const recordings: Recording[] = [];
  let providers: LlmProvider[];
  if (options.mode === 'replay-all') {
    const file = await loadRecordings(modelPath);
    const account = file.recordings[0]?.providerAccount ?? 'earthruntime';
    providers = [createReplayProvider(file, account, account === 'anthropic' ? 'anthropic' : 'openai_compatible')];
  } else {
    providers = liveProviders();
    if (options.record) providers = providers.map((p) => createRecordingProvider(p, recordings));
  }

  // Tool edges: fixtures, or (live) the real search provider and the real egress-safe fetcher.
  let search: SearchProvider | undefined;
  let fetcher: PageFetcher | undefined;
  if (options.mode !== 'live') {
    const fixtures = ToolFixtures.parse(await readJson(toolsPath));
    search = fixtureSearch(fixtures);
    fetcher = fixtureFetcher(fixtures);
  }

  const harness = await createTestHarness();
  const foreign = await harness.admin.query<{ n: number }>(
    `select count(*)::int as n from public.tasks where type = 'discover_companies' and status in ('ready', 'running')`,
  );
  if ((foreign.rows[0]?.n ?? 0) > 0) {
    await harness.close();
    throw new Error('Other runs have claimable discovery tasks in this database; evals would compete with them.');
  }
  const tenant = await harness.createTenant(`eval-${evalCase.id}`);
  const http = createServer();
  let stopScheduler: (() => Promise<void>) | null = null;
  try {
    const runId = await createRun(harness.db, { userId: tenant.userId }, tenant.workspaceId, {
      projectId: tenant.projectId,
      objective: evalCase.input.objective,
      budget: DEFAULT_RUN_BUDGET,
      seedUrls: evalCase.input.seedUrls,
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

    // MCP server, in-process, over HTTP, with a fresh keypair.
    const keys = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const services = createServices({
      db: harness.db,
      log,
      now,
      tavilyApiKey: process.env.TAVILY_API_KEY,
      ...(search ? { search } : {}),
      ...(fetcher ? { fetcher } : {}),
    });
    let recordedTools: ToolFixtures | null = null;
    if (options.mode === 'live' && options.record) {
      const edges = recordingEdges(services.search, services.fetcher);
      services.search = edges.search;
      services.fetcher = edges.fetcher;
      recordedTools = edges.recorded;
    }
    const handler = createHttpHandler({
      verify: await createTokenVerifier(JSON.stringify(await exportJWK(keys.publicKey))),
      services,
      log,
    });
    http.on('request', (req, res) => void handler(req, res));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const mcpUrl = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}/mcp`;

    // Worker: the production scheduler with only the task type under evaluation.
    const handlers = createHandlers({
      router: new LlmRouter({ providers }),
      mintToken: await createTokenMinter(JSON.stringify(await exportJWK(keys.privateKey))),
      connectTools: (token) => connectMcp(mcpUrl, token),
      now,
    });
    const discover = handlers.discover_companies;
    if (!discover) throw new Error('The worker registers no discover_companies handler');
    const scheduler = createScheduler({
      db: harness.connect('eval-worker', 8),
      workerId: `eval-${evalCase.id}`,
      handlers: { discover_companies: discover },
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
      const { rows } = await harness.admin.query<{ status: string; run_status: string }>(
        `select t.status, r.status as run_status from public.tasks t join public.runs r on r.id = t.run_id
         where t.run_id = $1 and t.type = 'discover_companies'`,
        [runId],
      );
      const state = rows[0];
      if (!state || ['succeeded', 'failed', 'cancelled'].includes(state.status) || state.run_status === 'paused') break;
      if (Date.now() - started > evalCase.expect.limits.maxWallClockMs + 30_000) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await scheduler.stop();
    stopScheduler = null;

    const metrics = await collectMetrics(harness.admin, runId, evalCase);
    const failures = score(evalCase, metrics, options.baseline);

    if (options.record) {
      if (recordings.length > 0)
        await saveRecordings(modelPath, { version: 1, synthetic: evalCase.synthetic, recordings });
      if (recordedTools) {
        await mkdir(dirname(toolsPath), { recursive: true });
        await writeFile(toolsPath, `${JSON.stringify(recordedTools, null, 2)}\n`);
      }
    }
    // The full trace goes to the git-ignored results file in every mode, for diagnosing a failed case.
    const trace = { trace: await collectTrace(harness.admin, runId) };
    return { caseId: evalCase.id, mode: options.mode, passed: failures.length === 0, failures, metrics, ...trace };
  } finally {
    await stopScheduler?.();
    await new Promise((resolve) => http.close(resolve));
    await harness.close();
  }
}
