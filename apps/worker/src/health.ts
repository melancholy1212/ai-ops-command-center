import { createServer, type Server } from 'node:http';

export interface HealthState {
  readonly service: string;
  readonly instanceId: string;
  readonly startedAt: number;
  database: { ok: boolean; checkedAt: number | null };
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  service: string;
  instanceId: string;
  uptimeSeconds: number;
  database: { ok: boolean; checkedAt: string | null };
}

/**
 * Healthy means the last database check succeeded recently. A stale or failed check reports 503,
 * so the platform restarts or stops routing to an instance that lost its database.
 */
export function healthReport(
  state: HealthState,
  now: number,
  maxCheckAgeMs: number,
): { code: number; body: HealthReport } {
  const fresh = state.database.checkedAt !== null && now - state.database.checkedAt <= maxCheckAgeMs;
  const ok = state.database.ok && fresh;
  return {
    code: ok ? 200 : 503,
    body: {
      status: ok ? 'ok' : 'degraded',
      service: state.service,
      instanceId: state.instanceId,
      uptimeSeconds: Math.floor((now - state.startedAt) / 1000),
      database: {
        ok: state.database.ok,
        checkedAt: state.database.checkedAt === null ? null : new Date(state.database.checkedAt).toISOString(),
      },
    },
  };
}

export function startHealthServer(port: number, report: () => { code: number; body: HealthReport }): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const { code, body } = report();
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(port);
  return server;
}
