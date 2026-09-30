import 'server-only';
import type { UserId } from '@aoc/contracts';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../supabase/server';

/**
 * The signed-in user from a verified session token, or a redirect to sign-in. This is the authoritative check
 * (the proxy only redirects for convenience); the returned client reads as that user under row-level security.
 */
export async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims.sub;
  if (!userId) redirect('/sign-in');
  const email = typeof data.claims.email === 'string' ? data.claims.email : null;
  return { supabase, userId: userId as UserId, email };
}
