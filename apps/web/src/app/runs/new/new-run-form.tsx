'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Hint, Label, Select, Textarea } from '@/components/ui/field';
import { EMPTY_FORM_STATE, MAX_SEED_URLS } from '@/lib/run-forms';
import { createRunAction } from '../actions';

export function NewRunForm({ projects }: { projects: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(createRunAction, EMPTY_FORM_STATE);
  return (
    <form action={action} className="max-w-2xl space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="projectId">Project</Label>
        <Select id="projectId" name="projectId" required defaultValue={projects[0]?.id}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="objective">Objective</Label>
        <Textarea
          id="objective"
          name="objective"
          required
          minLength={10}
          maxLength={4000}
          rows={4}
          placeholder="Find seed-stage climate software startups in the Nordics that raised money in the last 12 months."
        />
        <Hint>The planner turns this into explicit criteria. You approve them before any research starts.</Hint>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="seedUrls">
          Seed pages{' '}
          <span className="font-normal text-ink-subtle">(optional, one per line, up to {MAX_SEED_URLS})</span>
        </Label>
        <Textarea
          id="seedUrls"
          name="seedUrls"
          rows={3}
          className="font-mono text-meta"
          placeholder="https://news.example/funding-roundup"
        />
        <Hint>
          Pages the research may open even if search does not find them. Fetching still obeys the egress rules.
        </Hint>
      </div>
      {state.error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" variant="primary" size="lg" disabled={pending || projects.length === 0}>
        {pending ? 'Creating…' : 'Create and start run'}
      </Button>
    </form>
  );
}
