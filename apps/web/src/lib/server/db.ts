import 'server-only';
import { parseEnv, PostgresUrl } from '@aoc/config/env';
import { createDb, type Database } from '@aoc/db';
import { z } from 'zod';

const ServerEnv = z.object({
  /** The backend login role (docs/security.md). Server side only: commands run through packages/core with it. */
  DATABASE_URL: PostgresUrl,
});

const cache = globalThis as typeof globalThis & { aocCommandDb?: Database };

/** Created on first use, not at import time: `next build` runs without database credentials. */
export function commandDb(): Database {
  if (!cache.aocCommandDb) {
    const env = parseEnv('web', ServerEnv, { DATABASE_URL: process.env.DATABASE_URL });
    cache.aocCommandDb = createDb(env.DATABASE_URL, { applicationName: 'web', maxConnections: 3 });
  }
  return cache.aocCommandDb;
}
