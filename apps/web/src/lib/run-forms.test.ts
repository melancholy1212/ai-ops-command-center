import { describe, expect, it } from 'vitest';
import { parseDecisionForm, parseNewRunForm, parseSeedUrls } from './run-forms';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const PROJECT = '6f1c2d34-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const HASH = 'a'.repeat(64);

describe('parseSeedUrls', () => {
  it('splits on lines and spaces, drops blanks and duplicates', () => {
    expect(parseSeedUrls('https://a.example/x\n\n  https://b.example  https://a.example/x\n')).toEqual({
      ok: true,
      value: ['https://a.example/x', 'https://b.example'],
    });
    expect(parseSeedUrls('   ')).toEqual({ ok: true, value: [] });
  });

  it('names the line that is not a web URL, and caps the count', () => {
    expect(parseSeedUrls('https://a.example\nnot a url')).toEqual({ ok: false, error: '"not" is not a URL.' });
    expect(parseSeedUrls('ftp://files.example/x')).toEqual({
      ok: false,
      error: '"ftp://files.example/x" must start with https:// or http://.',
    });
    const many = Array.from({ length: 21 }, (_, i) => `https://s${String(i)}.example`).join('\n');
    expect(parseSeedUrls(many)).toEqual({ ok: false, error: 'At most 20 seed URLs.' });
  });
});

describe('parseNewRunForm', () => {
  it('accepts a project, an objective and optional seed pages', () => {
    expect(
      parseNewRunForm(form({ projectId: PROJECT, objective: '  Find Nordic climate startups  ', seedUrls: '' })),
    ).toEqual({ ok: true, value: { projectId: PROJECT, objective: 'Find Nordic climate startups', seedUrls: [] } });
  });

  it('explains what is wrong', () => {
    expect(parseNewRunForm(form({ projectId: 'x', objective: 'Find Nordic climate startups' }))).toEqual({
      ok: false,
      error: 'Choose a project.',
    });
    expect(parseNewRunForm(form({ projectId: PROJECT, objective: 'short' }))).toEqual({
      ok: false,
      error: 'Describe the objective in at least 10 characters.',
    });
  });
});

describe('parseDecisionForm', () => {
  const base = { approvalId: PROJECT, snapshotHash: HASH };
  it('reads an approval with the displayed hash; an empty reason is no reason', () => {
    expect(parseDecisionForm(form({ ...base, decision: 'approved', reason: '  ' }))).toEqual({
      ok: true,
      value: { ...base, decision: 'approved', reason: null },
    });
  });

  it('requires a reason to reject, and refuses a malformed hash or decision', () => {
    expect(parseDecisionForm(form({ ...base, decision: 'rejected', reason: '' }))).toEqual({
      ok: false,
      error: 'A rejection needs a reason.',
    });
    expect(parseDecisionForm(form({ ...base, decision: 'rejected', reason: 'Too broad' })).ok).toBe(true);
    expect(parseDecisionForm(form({ ...base, snapshotHash: 'abc', decision: 'approved' })).ok).toBe(false);
    expect(parseDecisionForm(form({ ...base, decision: 'maybe' })).ok).toBe(false);
  });
});
