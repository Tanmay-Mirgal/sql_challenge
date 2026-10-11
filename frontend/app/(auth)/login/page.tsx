import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthScreen } from "@/components/auth/auth-screen";
import { getSession } from "@/lib/auth";
import { safeNextPath } from "@/lib/safe-redirect";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { session } = await getSession();
  if (session) redirect("/dashboard");
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : undefined;
  return <AuthScreen mode="login" error={error} next={safeNextPath(params.next)} />;
}
