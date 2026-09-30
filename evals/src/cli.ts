/**
 * pnpm --filter @aoc/evals eval --mode replay-all|replay-tools|live [--case <id>] [--record] [--update-baseline]
 *
 *   replay-all    recorded tools and model: free, deterministic, runs in CI
 *   replay-tools  recorded tools, live model: measures model and prompt behaviour on fixed inputs
 *   live          live tools and model: records new fixtures with --record; manual and budgeted
 *
 * Exits non-zero if any case fails its gates or regresses against the committed baseline.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvalCase, EvalMode } from './case';
import type { CaseResult } from './metrics';
import { runCase } from './runner';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const casesDir = join(root, 'cases');

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  const mode = EvalMode.parse(arg('mode') ?? 'replay-all');
  const only = arg('case');
  const ids = (await readdir(casesDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const cases = await Promise.all(
    ids
      .filter((id) => !only || id === only)
      .map(async (id) => EvalCase.parse(JSON.parse(await readFile(join(casesDir, id, 'case.json'), 'utf8')))),
  );
  const runnable = cases.filter((c) => c.modes.includes(mode));
  if (cases.length === 0 || runnable.length === 0) {
    console.error(only ? `No case named ${only}` : 'No cases found');
    return 1;
  }

  const baselinePath = join(root, 'baselines', `${mode}.json`);
  const baseline = await readFile(baselinePath, 'utf8')
    .then((text) => JSON.parse(text) as { cases: Record<string, CaseResult['metrics']> })
    .catch((): { cases: Record<string, CaseResult['metrics']> } => ({ cases: {} }));
  const useBaseline = mode !== 'live' && !flag('update-baseline');

  const results: CaseResult[] = [];
  for (const evalCase of runnable) {
    const result = await runCase(evalCase, {
      mode,
      record: flag('record'),
      casesDir,
      ...(useBaseline && baseline.cases[evalCase.id] ? { baseline: baseline.cases[evalCase.id] } : {}),
      log: (line) => {
        console.log(line);
      },
    });
    results.push(result);
    const m = result.metrics;
    console.log(
      `${result.passed ? 'PASS' : 'FAIL'} ${evalCase.id}: proposed ${String(m.companiesProposed.length)} companies ` +
        `(${String(m.expectedFound.length)}/${String(evalCase.expect.companies.length)} expected), ${String(m.claimsProposed)} claims, ` +
        `${String(m.llmCalls)} model calls, ${String(m.toolCalls)} tool calls, ${String(m.sources)} sources, ` +
        `cost ${(m.costUsdMicros / 1e6).toFixed(4)} USD, quote match ${m.quoteMatchRate === null ? 'n/a' : String(m.quoteMatchRate)}`,
    );
    for (const failure of result.failures) console.log(`     - ${failure}`);
    const out = join(root, 'results', mode, `${evalCase.id}.json`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  }

  if (flag('update-baseline')) {
    const updated = {
      ...baseline,
      cases: { ...baseline.cases, ...Object.fromEntries(results.map((r) => [r.caseId, r.metrics])) },
    };
    await mkdir(dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, `${JSON.stringify(updated, null, 2)}\n`);
    console.log(`baseline updated: ${baselinePath}`);
  }
  const failed = results.filter((r) => !r.passed).length;
  console.log(`${String(results.length - failed)}/${String(results.length)} cases passed (${mode})`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
