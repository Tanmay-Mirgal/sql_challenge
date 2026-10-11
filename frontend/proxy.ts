import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Optimistic gate: bounce visitors that have no session cookie at all to /login.
 * This is only a UX shortcut — it cannot validate the session. The authoritative
 * checks are (1) the server-side session lookup in the route-group layouts and
 * (2) the Express API, which re-validates the session, role, round access and
 * eligibility on every request.
 *
 * Requires the API and the frontend to share a registrable domain (or run behind
 * one reverse proxy) so the session cookie is visible here; see README.
 */
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? "sql_challenge_session";

export function proxy(request: NextRequest) {
  if (!request.cookies.has(SESSION_COOKIE)) {
    const url = request.nextUrl.clone();
    const next = request.nextUrl.pathname + request.nextUrl.search;
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(next)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/challenge/:path*", "/leaderboard/:path*", "/profile/:path*", "/results/:path*", "/admin/:path*"],
};
