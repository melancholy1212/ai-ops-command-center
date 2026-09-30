// The web command layer against the local database: the user is resolved by the caller, packages/core
// authorises and performs the transition. Next.js is not involved.
import type { RunId } from '@aoc/contracts';
import { createTestHarness, type TestHarness, type TestTenant } from '@aoc/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelRunFor, commandErrorMessage, createAndStartRun } from './run-commands';

let h: TestHarness;
let owner: TestTenant;
let stranger: TestTenant;

beforeAll(async () => {
  h = await createTestHarness();
  owner = await h.createTenant('web-owner');
  stranger = await h.createTenant('web-stranger');
});
afterAll(async () => {
  await h.admin.query('delete from public.runs where workspace_id = any($1)', [
    [owner.workspaceId, stranger.workspaceId],
  ]);
  await h.close();
});

const input = (projectId: string) => ({
  projectId,
  objective: 'Find seed-stage climate software startups in the Nordics.',
  seedUrls: ['https://news.example/funding'],
});

describe('web run commands', () => {
  it('creates and starts a run, making the seed pages fetchable in it', async () => {
    const runId = await createAndStartRun(h.db, owner.userId, owner.workspaceId, input(owner.projectId));
    const { rows } = await h.admin.query<{ status: string; created_by: string }>(
      'select status, created_by from public.runs where id = $1',
      [runId],
    );
    expect(rows[0]).toEqual({ status: 'planning', created_by: owner.userId });
    const { rows: urls } = await h.admin.query<{ normalized_url: string }>(
      'select normalized_url from public.discovered_urls where run_id = $1',
      [runId],
    );
    expect(urls).toEqual([{ normalized_url: 'https://news.example/funding' }]);

    await cancelRunFor(h.db, owner.userId, owner.workspaceId, runId);
    const { rows: after } = await h.admin.query<{ status: string }>('select status from public.runs where id = $1', [
      runId,
    ]);
    expect(after[0]?.status).toBe('cancelled');
  });

  it('refuses a user outside the workspace with a message safe to show', async () => {
    const error = await createAndStartRun(h.db, stranger.userId, owner.workspaceId, input(owner.projectId)).catch(
      (e: unknown) => e,
    );
    expect(commandErrorMessage(error)).toMatch(/not a member|not found|permission/i);
    const refused = await cancelRunFor(
      h.db,
      stranger.userId,
      owner.workspaceId,
      '00000000-0000-4000-8000-000000000000' as RunId,
    ).catch((e: unknown) => e);
    expect(commandErrorMessage(refused)).not.toMatch(/Try again/);
  });

  it('never shows the text of an unexpected error', () => {
    expect(commandErrorMessage(new Error('password authentication failed for user aoc_service'))).toBe(
      'The command could not be completed. Try again in a moment.',
    );
  });
});
