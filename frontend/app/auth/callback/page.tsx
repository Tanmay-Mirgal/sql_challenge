import type { Metadata } from "next";
import { Suspense } from "react";
import { CallbackHandler } from "@/components/auth/callback-handler";

export const metadata: Metadata = { title: "Signing in" };

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackHandler />
    </Suspense>
  );
}
