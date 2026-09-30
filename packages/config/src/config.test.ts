import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvValidationError, LogLevel, parseEnv, PostgresUrl, Port } from './env';
import { createLogger } from './logger';

const Schema = z.object({ DATABASE_URL: PostgresUrl, HEALTH_PORT: Port, LOG_LEVEL: LogLevel });

describe('parseEnv', () => {
  it('parses and coerces a valid environment', () => {
    const env = parseEnv('worker', Schema, { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', HEALTH_PORT: '8081' });
    expect(env).toEqual({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db', HEALTH_PORT: 8081, LOG_LEVEL: 'info' });
  });

  it('lists every problem at once', () => {
    let error: unknown;
    try {
      parseEnv('worker', Schema, { HEALTH_PORT: 'not-a-port' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    const problems = (error as EnvValidationError).problems;
    expect(problems).toContain('DATABASE_URL: missing');
    expect(problems.some((p) => p.startsWith('HEALTH_PORT:'))).toBe(true);
  });

  it('never echoes a value in its error', () => {
    const secret = 'https://user:SuperSecret123@example.com';
    expect(() => parseEnv('worker', Schema, { DATABASE_URL: secret, HEALTH_PORT: '1' })).toThrow(EnvValidationError);
    try {
      parseEnv('worker', Schema, { DATABASE_URL: secret, HEALTH_PORT: '1' });
    } catch (e) {
      expect((e as Error).message).not.toContain('SuperSecret123');
    }
  });
});

describe('createLogger', () => {
  it('redacts secrets and keeps ids as fields', () => {
    const lines: string[] = [];
    const logger = createLogger('test', 'info', { write: (line: string) => lines.push(line) });
    logger.info({ runId: 'r-1', apiKey: 'sk-live-123', provider: { token: 'tok-456' } }, 'called provider');
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({ service: 'test', runId: 'r-1', apiKey: '[redacted]', msg: 'called provider' });
    expect(entry.provider).toEqual({ token: '[redacted]' });
    expect(lines[0]).not.toContain('sk-live-123');
  });
});
