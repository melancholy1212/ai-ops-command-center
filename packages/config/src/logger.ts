/**
 * Structured JSON logging. Every service logs through this, so field names and redaction are uniform.
 * Ids (workspaceId, runId, taskId, executionId, ...) go in fields, never in the message text.
 */
import { pino, type DestinationStream, type Logger } from 'pino';

/** Paths whose values are replaced before a log line is written. */
export const REDACTED_PATHS = [
  'authorization',
  'cookie',
  '*.authorization',
  '*.cookie',
  'headers.authorization',
  'headers.cookie',
  'apiKey',
  '*.apiKey',
  'token',
  '*.token',
  'password',
  '*.password',
  'secret',
  '*.secret',
  'databaseUrl',
  '*.databaseUrl',
  'connectionString',
  '*.connectionString',
];

export function createLogger(service: string, level = 'info', destination?: DestinationStream): Logger {
  const options = {
    name: service,
    level,
    base: { service },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
