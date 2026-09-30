#!/usr/bin/env node
// Local development setup. Requires the local Supabase stack (`pnpm db:start`).
//   1. gives the aoc_service login role a fresh random password (local database only)
//   2. writes git-ignored .env.local files for web, worker and mcp-server, including this machine's
//      LAN addresses as allowed dev origins (so the app also works when opened from another computer)
// Secrets are never printed. Rerunning rotates the local password and rewrites the files.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, input) =>
  execFileSync(cmd, args, { cwd: root, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

const status = Object.fromEntries(
  run('pnpm', ['exec', 'supabase', 'status', '-o', 'env'])
    .split('\n')
    .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
for (const key of ['API_URL', 'DB_URL', 'PUBLISHABLE_KEY']) {
  if (!status[key])
    throw new Error(`supabase status did not report ${key}. Is the local stack running (pnpm db:start)?`);
}

// The password goes to psql on stdin, so it never appears in a process list.
const password = randomBytes(24).toString('hex');
run(
  'docker',
  [
    'exec',
    '-i',
    'supabase_db_ai-ops-command-center',
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
  ],
  `alter role aoc_service password '${password}';\n`,
);

const db = new URL(status.DB_URL);
db.username = 'aoc_service';
db.password = password;

// Non-loopback IPv4 addresses, e.g. the VM's address when the browser runs on the host machine.
const lanAddresses = Object.values(networkInterfaces())
  .flat()
  .filter((net) => net && net.family === 'IPv4' && !net.internal)
  .map((net) => net.address);

const header = '# Written by `pnpm setup:local`. Local development only; never commit.\n';
const files = {
  'apps/web/.env.local': {
    NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY,
    ALLOWED_DEV_ORIGINS: lanAddresses.join(','),
  },
  'apps/worker/.env.local': { DATABASE_URL: db.toString(), LOG_LEVEL: 'info', HEALTH_PORT: '8081' },
  'apps/mcp-server/.env.local': { LOG_LEVEL: 'info', HEALTH_PORT: '8082' },
};
for (const [file, vars] of Object.entries(files)) {
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(join(root, file), `${header}${body}\n`, { mode: 0o600 });
  console.log(`wrote ${file} (${Object.keys(vars).join(', ')})`);
}
console.log('aoc_service password rotated on the local database.');
if (lanAddresses.length > 0)
  console.log(`web dev server also reachable at: ${lanAddresses.map((a) => `http://${a}:3000`).join(', ')}`);
