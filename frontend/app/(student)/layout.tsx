import { AuthHydrator } from "@/components/auth/auth-hydrator";
import { SiteHeader } from "@/components/layout/site-header";
import { requireSession } from "@/lib/auth";

/**
 * Server-side gate for every participant page: resolves the session with the API
 * (forwarding the cookie) and redirects to /login when there is none.
 */
export default async function StudentLayout({ children }: LayoutProps<"/">) {
  const session = await requireSession();
  return (
    <>
      <AuthHydrator session={session} />
      <SiteHeader user={session.user} />
      <main className="flex flex-1 flex-col">{children}</main>
    </>
  );
}
