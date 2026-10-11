import { buttonVariants } from "@/components/ui/button";
import { API_BASE_URL } from "@/lib/env";
import { cn } from "@/lib/utils";

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path fill="#4285F4" d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.55-5.17 3.55-8.87Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.71-4.95H1.28v3.09A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.29 14.3a7.2 7.2 0 0 1 0-4.6V6.61H1.28a12 12 0 0 0 0 10.78l4.01-3.09Z" />
      <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.94 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.61L5.29 9.7C6.23 6.86 8.88 4.75 12 4.75Z" />
    </svg>
  );
}

/** Plain link: the browser navigates to the API, which redirects to Google (authorization-code + PKCE). */
export function GoogleButton({ next, label = "Continue with Google", disabled }: { next?: string; label?: string; disabled?: boolean }) {
  const href = `${API_BASE_URL}/auth/google${next ? `?returnTo=${encodeURIComponent(next)}` : ""}`;
  return (
    <a
      href={disabled ? undefined : href}
      aria-disabled={disabled}
      className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-10 w-full gap-2.5 text-sm", disabled && "pointer-events-none opacity-50")}
    >
      <GoogleMark className="size-4" />
      {label}
    </a>
  );
}
