import type { Budget, Spend } from '@aoc/contracts';
import { describe, expect, it } from 'vitest';
import { retryDelayMs } from './backoff';
import { crossedThresholds, evaluateBudget, proposeExtension } from './budget';
import { canonicalJson, snapshotHash } from './canonical-json';
import { findCycle } from './graph';

describe('canonicalJson (RFC 8785)', () => {
  it('matches the specification example (sorted keys, ES number and string serialisation)', () => {
    // RFC 8785 section 3.2.2 input and expected output.
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    ) as unknown;
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('is independent of key order and drops undefined properties', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' }, z: undefined })).toBe(
      canonicalJson({ a: { c: 'x', d: [1, 2] }, b: 1 }),
    );
  });

  it('gives different hashes for different content, equal hashes for equal content', () => {
    expect(snapshotHash({ kind: 'plan', a: 1 })).toBe(snapshotHash({ a: 1, kind: 'plan' }));
    expect(snapshotHash({ kind: 'plan', a: 1 })).not.toBe(snapshotHash({ kind: 'plan', a: 2 }));
    expect(snapshotHash({})).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses values JSON cannot represent', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
  });
});

describe('retryDelayMs', () => {
  const policy = { baseMs: 1_000, maxMs: 10_000, jitterMs: 500 };
  it('doubles per attempt, caps, and adds bounded jitter', () => {
    expect(retryDelayMs(1, policy, () => 0)).toBe(1_000);
    expect(retryDelayMs(2, policy, () => 0)).toBe(2_000);
    expect(retryDelayMs(3, policy, () => 0)).toBe(4_000);
    expect(retryDelayMs(10, policy, () => 0)).toBe(10_000);
    expect(retryDelayMs(1, policy, () => 0.999)).toBe(1_499);
  });
});

describe('budget', () => {
  const budget: Budget = {
    maxCostUsdMicros: 1_000_000,
    maxLlmTokens: 100_000,
    maxToolCalls: 50,
    maxWallClockSeconds: 600,
  };
  const spend = (costUsdMicros: number, tokens = 0, toolCalls = 0): Spend => ({
    costUsdMicros,
    llmInputTokens: tokens,
    llmOutputTokens: 0,
    toolCalls,
  });
  const started = new Date('2026-09-30T12:00:00Z');
  const est = { costUsdMicros: 150_000, llmTokens: 20_000, toolCalls: 10 };

  it('allows work that fits every dimension', () => {
    expect(evaluateBudget({ budget, spend: spend(0), startedAt: started }, est, started)).toEqual({
      ok: true,
      exhausted: [],
    });
  });

  it('names every exhausted dimension', () => {
    const result = evaluateBudget(
      { budget, spend: spend(900_000, 90_000, 45), startedAt: null },
      est,
      new Date(started.getTime() + 601_000),
    );
    expect(result).toEqual({ ok: false, exhausted: ['cost', 'tokens', 'toolCalls'] });
    const late = evaluateBudget(
      { budget, spend: spend(0), startedAt: started },
      est,
      new Date(started.getTime() + 601_000),
    );
    expect(late).toEqual({ ok: false, exhausted: ['wallClock'] });
  });

  it('proposes raising only exhausted dimensions, within ceilings', () => {
    expect(proposeExtension(budget, ['cost'])).toEqual({ ...budget, maxCostUsdMicros: 1_500_000 });
    expect(proposeExtension({ ...budget, maxToolCalls: 4_000 }, ['toolCalls']).maxToolCalls).toBe(5_000);
  });

  it('reports cost thresholds crossed, once each', () => {
    expect(crossedThresholds(spend(400_000), spend(850_000), budget)).toEqual([50, 80]);
    expect(crossedThresholds(spend(850_000), spend(900_000), budget)).toEqual([]);
    expect(crossedThresholds(spend(900_000), spend(1_000_000), budget)).toEqual([100]);
  });
});

describe('findCycle', () => {
  it('accepts a DAG, including diamonds', () => {
    expect(
      findCycle([
        { taskId: 'b', dependsOnTaskId: 'a' },
        { taskId: 'c', dependsOnTaskId: 'a' },
        { taskId: 'd', dependsOnTaskId: 'b' },
        { taskId: 'd', dependsOnTaskId: 'c' },
      ]),
    ).toBeNull();
  });

  it('finds a cycle and returns its path', () => {
    const cycle = findCycle([
      { taskId: 'a', dependsOnTaskId: 'b' },
      { taskId: 'b', dependsOnTaskId: 'c' },
      { taskId: 'c', dependsOnTaskId: 'a' },
    ]);
    expect(cycle).not.toBeNull();
    expect(cycle?.[0]).toBe(cycle?.at(-1));
    expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']));
  });
});
