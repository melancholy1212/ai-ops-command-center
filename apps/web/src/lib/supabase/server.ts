import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { publicEnv } from '../env';
import type { Database } from './database.types';

/**
 * Supabase client for Server Components, Server Actions and Route Handlers. It acts as the signed-in
 * user, so every query is filtered by row-level security. Create one per request.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
          } catch {
            // Server Components can't set cookies; the proxy refreshes the session on every request.
          }
        },
      },
    },
  );
}
