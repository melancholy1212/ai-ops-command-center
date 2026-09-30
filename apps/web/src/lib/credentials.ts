import { z } from 'zod';

export const Credentials = z.object({
  email: z.email().max(254),
  // bcrypt, which Supabase Auth uses, ignores bytes beyond 72.
  password: z.string().min(8).max(72),
});
export type Credentials = z.infer<typeof Credentials>;

/** Reads the form without trusting it. */
export function parseCredentials(formData: FormData): Credentials | null {
  const result = Credentials.safeParse({ email: formData.get('email'), password: formData.get('password') });
  return result.success ? result.data : null;
}
