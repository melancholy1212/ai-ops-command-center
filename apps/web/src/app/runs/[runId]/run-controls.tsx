'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
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
          <Button type="submit" variant="primary" name="intent" value="start" disabled={pending}>
            Start run
          </Button>
        ) : null}
        {canCancel ? (
          <Button type="submit" variant="danger" name="intent" value="cancel" disabled={pending}>
            Cancel run
          </Button>
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
