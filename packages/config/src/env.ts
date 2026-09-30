/**
 * Environment validation. Each service declares a Zod schema for the variables it needs and parses
 * the environment once at startup. Invalid or missing variables fail fast with every problem listed.
 * Values are never included in errors or logs, because many of them are secrets.
 */
import { z } from 'zod';

export class EnvValidationError extends Error {
  constructor(
    readonly service: string,
    readonly problems: readonly string[],
  ) {
    super(`Invalid environment for ${service}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

export function parseEnv<S extends z.ZodType>(
  service: string,
  schema: S,
  source: Readonly<Record<string, string | undefined>> = process.env,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return issue.code === 'invalid_type' && issue.input === undefined
        ? `${name}: missing`
        : `${name}: ${issue.message}`;
    });
    throw new EnvValidationError(service, problems);
  }
  return result.data;
}

// Reusable field schemas -----------------------------------------------------

export const PostgresUrl = z.string().regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// connection string');
export const Port = z.coerce.number().int().min(1).max(65_535);
export const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info');
export const NodeEnv = z.enum(['development', 'test', 'production']).default('development');
