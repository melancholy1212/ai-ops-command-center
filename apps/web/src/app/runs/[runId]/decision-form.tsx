'use client';

import { useActionState } from 'react';
import { EMPTY_FORM_STATE } from '@/lib/run-forms';
import { decideApprovalAction } from '../actions';

/** Submits the hash of the snapshot this page displayed; the command refuses it if the approval changed since. */
export function DecisionForm({ approvalId, snapshotHash }: { approvalId: string; snapshotHash: string }) {
  const [state, action, pending] = useActionState(decideApprovalAction, EMPTY_FORM_STATE);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="approvalId" value={approvalId} />
      <input type="hidden" name="snapshotHash" value={snapshotHash} />
      <label htmlFor={`reason-${approvalId}`} className="block text-xs text-ink-muted">
        Reason <span className="text-ink-subtle">(required to reject)</span>
      </label>
      <textarea
        id={`reason-${approvalId}`}
        name="reason"
        rows={2}
        maxLength={2000}
        className="w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink"
      />
      {state.error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-2 text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          name="decision"
          value="approved"
          disabled={pending}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-canvas disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="submit"
          name="decision"
          value="rejected"
          disabled={pending}
          className="rounded-md border border-danger/50 px-3 py-1.5 text-sm text-danger disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    </form>
  );
}
