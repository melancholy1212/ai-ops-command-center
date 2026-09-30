'use server';

import { redirect } from 'next/navigation';
import type { AuthFormState } from '@/lib/auth-form-state';
import { parseCredentials } from '@/lib/credentials';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const INVALID_INPUT = 'Enter a valid email and a password of at least 8 characters.';

// Messages never reveal whether an account exists.
export async function signIn(_previous: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const credentials = parseCredentials(formData);
  if (!credentials) return { error: INVALID_INPUT, notice: null };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(credentials);
  if (error) return { error: 'Email or password is incorrect.', notice: null };
  redirect('/dashboard');
}

export async function signUp(_previous: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const credentials = parseCredentials(formData);
  if (!credentials) return { error: INVALID_INPUT, notice: null };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp(credentials);
  if (error) return { error: 'Could not create the account. Try another email or a stronger password.', notice: null };
  // With email confirmation on (production), there is no session until the user confirms.
  if (!data.session) return { error: null, notice: 'Check your email to confirm your account, then sign in.' };
  redirect('/dashboard');
}
