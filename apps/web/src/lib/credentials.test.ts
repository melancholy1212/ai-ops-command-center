import { describe, expect, it } from 'vitest';
import { parseCredentials } from './credentials';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe('parseCredentials', () => {
  it('accepts a valid email and password', () => {
    expect(parseCredentials(form({ email: 'ada@example.com', password: 'correct horse' }))).toEqual({
      email: 'ada@example.com',
      password: 'correct horse',
    });
  });

  it('rejects malformed emails, short passwords and missing fields', () => {
    expect(parseCredentials(form({ email: 'not-an-email', password: 'long enough' }))).toBeNull();
    expect(parseCredentials(form({ email: 'ada@example.com', password: 'short' }))).toBeNull();
    expect(parseCredentials(form({ email: 'ada@example.com' }))).toBeNull();
  });

  it('rejects passwords longer than bcrypt accepts', () => {
    expect(parseCredentials(form({ email: 'ada@example.com', password: 'x'.repeat(73) }))).toBeNull();
  });
});
