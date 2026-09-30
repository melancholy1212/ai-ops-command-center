import { EnvValidationError } from '@aoc/config/env';
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';
import { healthReport, type HealthState } from './health';

describe('worker env', () => {
  it('applies defaults', () => {
    const env = loadEnv({ DATABASE_URL: 'postgresql://aoc_service:x@127.0.0.1:55322/postgres' });
    expect(env).toMatchObject({ HEALTH_PORT: 8081, HEARTBEAT_INTERVAL_MS: 15_000, LOG_LEVEL: 'info' });
    expect(env.WORKER_ID.length).toBeGreaterThan(0);
  });

  it('refuses to start without a database URL', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
  });
});

describe('healthReport', () => {
  const base: HealthState = {
    service: 'worker',
    instanceId: 'w-1',
    startedAt: 0,
    database: { ok: true, checkedAt: 55_000 },
  };

  it('is healthy when the last database check succeeded recently', () => {
    const { code, body } = healthReport(base, 60_000, 45_000);
    expect(code).toBe(200);
    expect(body).toMatchObject({ status: 'ok', uptimeSeconds: 60, database: { ok: true } });
  });

  it('is degraded when the database check failed', () => {
    expect(healthReport({ ...base, database: { ok: false, checkedAt: 55_000 } }, 60_000, 45_000).code).toBe(503);
  });

  it('is degraded when the last check is too old, even if it succeeded', () => {
    expect(healthReport(base, 200_000, 45_000).code).toBe(503);
  });

  it('is degraded before the first check', () => {
    expect(healthReport({ ...base, database: { ok: false, checkedAt: null } }, 1_000, 45_000).code).toBe(503);
  });
});
