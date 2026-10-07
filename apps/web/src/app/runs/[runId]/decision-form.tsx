'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Label, Textarea } from '@/components/ui/field';
import { EMPTY_FORM_STATE } from '@/lib/run-forms';
import { decideApprovalAction } from '../actions';

/** Submits the hash of the snapshot this page displayed; the command refuses it if the approval changed since. */
export function DecisionForm({ approvalId, snapshotHash }: { approvalId: string; snapshotHash: string }) {
  const [state, action, pending] = useActionState(decideApprovalAction, EMPTY_FORM_STATE);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="approvalId" value={approvalId} />
      <input type="hidden" name="snapshotHash" value={snapshotHash} />
      <Label htmlFor={`reason-${approvalId}`}>
        Reason <span className="font-normal text-ink-subtle">(required to reject)</span>
      </Label>
      <Textarea id={`reason-${approvalId}`} name="reason" rows={2} maxLength={2000} />
      {state.error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-2 text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" name="decision" value="approved" disabled={pending}>
          Approve
        </Button>
        <Button type="submit" variant="danger" name="decision" value="rejected" disabled={pending}>
          Reject
        </Button>
      </div>
    </form>
  );
}
