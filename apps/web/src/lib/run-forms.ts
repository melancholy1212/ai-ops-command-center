import { z } from 'zod';

/** What a command form shows after submitting: nothing, or one message safe to display. */
export interface FormState {
  error: string | null;
}
export const EMPTY_FORM_STATE: FormState = { error: null };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export const MAX_SEED_URLS = 20;

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/** One URL per line (or separated by spaces). The domain command validates them again, stricter. */
export function parseSeedUrls(input: string): Parsed<string[]> {
  const urls = [
    ...new Set(
      input
        .split(/\s+/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  if (urls.length > MAX_SEED_URLS) return { ok: false, error: `At most ${String(MAX_SEED_URLS)} seed URLs.` };
  for (const url of urls) {
    const shown = url.length > 80 ? `${url.slice(0, 80)}...` : url;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: `"${shown}" is not a URL.` };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      return { ok: false, error: `"${shown}" must start with https:// or http://.` };
  }
  return { ok: true, value: urls };
}

export interface NewRunInput {
  projectId: string;
  objective: string;
  seedUrls: string[];
}

const NewRunFields = z.object({
  projectId: z.uuid('Choose a project.'),
  objective: z
    .string()
    .trim()
    .min(10, 'Describe the objective in at least 10 characters.')
    .max(4000, 'Keep the objective under 4,000 characters.'),
});

export function parseNewRunForm(form: FormData): Parsed<NewRunInput> {
  const fields = NewRunFields.safeParse({ projectId: text(form, 'projectId'), objective: text(form, 'objective') });
  if (!fields.success) return { ok: false, error: fields.error.issues[0]?.message ?? 'Check the form.' };
  const seedUrls = parseSeedUrls(text(form, 'seedUrls'));
  if (!seedUrls.ok) return seedUrls;
  return { ok: true, value: { ...fields.data, seedUrls: seedUrls.value } };
}

export interface DecisionInput {
  approvalId: string;
  decision: 'approved' | 'rejected';
  /** The hash of the snapshot the page displayed: the command refuses it if the approval changed since. */
  snapshotHash: string;
  reason: string | null;
}

const DecisionFields = z.object({
  approvalId: z.uuid(),
  decision: z.enum(['approved', 'rejected']),
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export function parseDecisionForm(form: FormData): Parsed<DecisionInput> {
  const fields = DecisionFields.safeParse({
    approvalId: text(form, 'approvalId'),
    decision: text(form, 'decision'),
    snapshotHash: text(form, 'snapshotHash'),
  });
  if (!fields.success) return { ok: false, error: 'The decision could not be read. Reload the page and try again.' };
  const reason = text(form, 'reason').trim().slice(0, 2000) || null;
  if (fields.data.decision === 'rejected' && reason === null)
    return { ok: false, error: 'A rejection needs a reason.' };
  return { ok: true, value: { ...fields.data, reason } };
}
