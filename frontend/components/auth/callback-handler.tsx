"use client";

import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api-client";
import { AUTH_ERROR_MESSAGES } from "@/lib/auth-config";
import { safeNextPath } from "@/lib/safe-redirect";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import type { MeResponse } from "@/types/api";

/** Landing page for the API's OAuth redirect: verifies the new session, then enters the app. */
export function CallbackHandler() {
  const params = useSearchParams();
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(params.get("error"));

  useEffect(() => {
    if (params.get("error")) return;
    let cancelled = false;
    api
      .get<MeResponse>("/auth/me")
      .then((me) => {
        if (cancelled) return;
        useAuthStore.getState().hydrate(me.user, me.csrfToken);
        router.replace(safeNextPath(params.get("next")));
        router.refresh();
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(error instanceof ApiError && error.status === 0 ? "api_unreachable" : "invalid_state");
      });
    return () => {
      cancelled = true;
    };
  }, [params, router]);

  if (failure) {
    const message = AUTH_ERROR_MESSAGES[failure] ?? { title: "Sign-in failed", body: "Something went wrong. Please try again." };
    return (
      <div className="grid min-h-dvh place-items-center p-6">
        <div role="alert" className="max-w-sm space-y-4 text-center">
          <div className="mx-auto grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangleIcon className="size-5" />
          </div>
          <h1 className="t-title">{message.title}</h1>
          <p className="text-sm text-muted-foreground">{message.body}</p>
          <Link href="/login" className={cn(buttonVariants(), "mx-auto")}>
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-dvh place-items-center p-6" role="status" aria-live="polite">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> Signing you in…
      </div>
    </div>
  );
}
