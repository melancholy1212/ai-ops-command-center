import { type NextRequest, NextResponse } from 'next/server';
import { updateSession } from './lib/supabase/proxy';

const PROTECTED_PREFIXES = ['/dashboard', '/runs'];
const AUTH_PAGES = ['/sign-in'];

/**
 * Keeps the session fresh and redirects for convenience. This is not the authorization check:
 * every protected page verifies the user itself, and the database enforces row-level security.
 */
export async function proxy(request: NextRequest) {
  const { response, userId } = await updateSession(request);
  const path = request.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

  let target: string | null = null;
  if (!userId && isProtected) target = '/sign-in';
  else if (userId && AUTH_PAGES.includes(path)) target = '/dashboard';
  if (!target) return response;

  const redirect = NextResponse.redirect(new URL(target, request.url));
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  return redirect;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health).*)'],
};
