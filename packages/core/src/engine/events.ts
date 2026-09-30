import { RunEvent, type Actor } from '@aoc/contracts';
import { toJson, type WorkspaceTransaction } from '@aoc/db';
import { sql } from 'kysely';

type EventOfType<T extends RunEvent['type']> = Extract<RunEvent, { type: T }>;

export type NewRunEvent = {
  [T in RunEvent['type']]: { type: T; data: EventOfType<T>['data']; refs?: EventOfType<T>['refs'] };
}[RunEvent['type']];

export interface RunRef {
  id: string;
  workspace_id: string;
}

/**
 * Appends one event to the run's timeline with the next gap-free sequence number. The payload is
 * validated against the RunEvent contract first, so the timeline can never hold a malformed event.
 */
export async function appendEvent(tx: WorkspaceTransaction, run: RunRef, actor: Actor, event: NewRunEvent) {
  const refs = event.refs ?? {};
  RunEvent.parse({
    ...event,
    refs,
    runId: run.id,
    workspaceId: run.workspace_id,
    seq: 1,
    occurredAt: new Date().toISOString(),
    actor,
  });
  const result = await sql<{ seq: string }>`
    select private.append_run_event(
      ${run.id}::uuid, ${event.type}, ${toJson(actor)}::jsonb, ${toJson(refs)}::jsonb, ${toJson(event.data)}::jsonb
    ) as seq`.execute(tx);
  return Number(result.rows[0]?.seq);
}
