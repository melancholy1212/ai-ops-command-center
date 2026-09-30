'use client';

import { useActionState } from 'react';
import { EMPTY_FORM_STATE, MAX_SEED_URLS } from '@/lib/run-forms';
import { createRunAction } from '../actions';

const field = 'w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-subtle';

export function NewRunForm({ projects }: { projects: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(createRunAction, EMPTY_FORM_STATE);
  return (
    <form action={action} className="max-w-2xl space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="projectId" className="text-sm text-ink-muted">
          Project
        </label>
        <select id="projectId" name="projectId" required className={field} defaultValue={projects[0]?.id}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="objective" className="text-sm text-ink-muted">
          Objective
        </label>
        <textarea
          id="objective"
          name="objective"
          required
          minLength={10}
          maxLength={4000}
          rows={4}
          className={field}
          placeholder="Find seed-stage climate software startups in the Nordics that raised money in the last 12 months."
        />
        <p className="text-xs text-ink-subtle">
          The planner turns this into explicit criteria. You approve them before any research starts.
        </p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="seedUrls" className="text-sm text-ink-muted">
          Seed pages <span className="text-ink-subtle">(optional, one per line, up to {MAX_SEED_URLS})</span>
        </label>
        <textarea
          id="seedUrls"
          name="seedUrls"
          rows={3}
          className={`${field} font-mono text-xs`}
          placeholder="https://news.example/funding-roundup"
        />
        <p className="text-xs text-ink-subtle">
          Pages the research may open even if search does not find them. Fetching still obeys the egress rules.
        </p>
      </div>
      {state.error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending || projects.length === 0}
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-canvas disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create and start run'}
      </button>
    </form>
  );
}
