import { parseEnv } from '@aoc/config/env';
import { z } from 'zod';

const PublicEnv = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  /** The publishable key only: the browser never receives a secret or service-role key. */
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
});

// Referenced literally so Next.js can inline them at build time.
export const publicEnv = parseEnv('web', PublicEnv, {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
});
