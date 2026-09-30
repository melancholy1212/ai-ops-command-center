'use client';

import { useActionState } from 'react';
import { EMPTY_FORM_STATE } from '@/lib/run-forms';
import { runControlAction } from '../actions';

export function RunControls({ runId, canStart, canCancel }: { runId: string; canStart: boolean; canCancel: boolean }) {
  const [state, action, pending] = useActionState(runControlAction, EMPTY_FORM_STATE);
  if (!canStart && !canCancel) return null;
  return (
    <form action={action} className="flex flex-col items-end gap-2">
      <input type="hidden" name="runId" value={runId} />
      <div className="flex gap-2">
        {canStart ? (
          <button
            type="submit"
            name="intent"
            value="start"
            disabled={pending}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-canvas disabled:opacity-50"
          >
            Start run
          </button>
        ) : null}
        {canCancel ? (
          <button
            type="submit"
            name="intent"
            value="cancel"
            disabled={pending}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-muted hover:text-danger disabled:opacity-50"
          >
            Cancel run
          </button>
        ) : null}
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
