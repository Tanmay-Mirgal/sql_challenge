import type { Metadata } from "next";
import { ShieldAlertIcon } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { getSession } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Not authorised" };

export default async function UnauthorizedPage() {
  const { session } = await getSession();
  const suspended = session && session.user.status !== "active";
  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <div className="max-w-sm space-y-4 text-center">
        <div className="mx-auto grid size-10 place-items-center rounded-full bg-muted">
          <ShieldAlertIcon className="size-5" />
        </div>
        <h1 className="t-title">{suspended ? "Account unavailable" : "You don’t have access to this page"}</h1>
        <p className="text-sm text-muted-foreground">
          {suspended
            ? "Your account is not currently permitted to take part. Please contact the organisers."
            : "This area is restricted. If you think this is a mistake, ask an organiser to review your permissions."}
        </p>
        <div className="flex justify-center gap-2">
          <Link href={session ? "/dashboard" : "/login"} className={cn(buttonVariants())}>
            {session ? "Go to dashboard" : "Sign in"}
          </Link>
        </div>
      </div>
    </div>
  );
}
