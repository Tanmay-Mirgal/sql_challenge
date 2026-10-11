import { AlertTriangleIcon, ServerCrashIcon, TerminalIcon } from "lucide-react";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { GoogleButton } from "@/components/auth/google-button";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AUTH_ERROR_MESSAGES, getAuthConfig } from "@/lib/auth-config";

const rounds = [
  { n: "01", name: "Basic", detail: "SELECT · WHERE · ORDER BY · aggregates", gate: "Everyone" },
  { n: "02", name: "Intermediate", detail: "JOINs · GROUP BY · HAVING · subqueries", gate: "Top 20" },
  { n: "03", name: "Advanced", detail: "CTEs · CASE · nested queries", gate: "Top 10" },
];

export async function AuthScreen({
  mode,
  error,
  next,
}: {
  mode: "login" | "register";
  error?: string;
  next?: string;
}) {
  const { config, unreachable } = await getAuthConfig();
  const known = error ? AUTH_ERROR_MESSAGES[error] : undefined;
  const isRegister = mode === "register";

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden flex-col justify-between border-r bg-foreground p-10 text-background lg:flex">
        <Logo className="text-background [&>span:first-child]:bg-background [&>span:first-child]:text-foreground" />
        <div className="max-w-md">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-background/60">Case file #0417</p>
          <h1 className="mt-4 text-4xl font-semibold leading-[1.05] tracking-[-0.035em]">
            Something doesn&apos;t add up in the registration database.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-background/70">
            A three-round SQL investigation. Each chapter continues the story — and gets harder. Read the schema, write the query,
            climb the board.
          </p>
          <ol className="mt-8 space-y-3">
            {rounds.map((round) => (
              <li key={round.n} className="flex items-baseline gap-4 border-t border-background/15 pt-3">
                <span className="font-mono text-xs text-background/50">{round.n}</span>
                <div className="flex-1">
                  <p className="text-sm font-medium">{round.name}</p>
                  <p className="font-mono text-xs text-background/55">{round.detail}</p>
                </div>
                <span className="font-mono text-[0.68rem] uppercase tracking-wider text-background/60">{round.gate}</span>
              </li>
            ))}
          </ol>
        </div>
        <p className="font-mono text-xs text-background/45">PostgreSQL sandbox · hidden test cases · live scoring</p>
      </aside>

      <section className="flex flex-col">
        <div className="flex items-center justify-between p-4 sm:p-6 lg:justify-end">
          <Logo className="lg:hidden" />
          <ThemeToggle />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 pb-16">
          <div className="space-y-2">
            <h2 className="t-title">{isRegister ? "Create your participant account" : "Welcome back"}</h2>
            <p className="text-sm text-muted-foreground">
              {isRegister
                ? "Registration uses your Google account — there is no separate password to remember."
                : "Sign in with the Google account you registered with."}
            </p>
          </div>

          {known ? (
            <Alert variant="destructive" role="alert">
              <AlertTriangleIcon />
              <AlertTitle>{known.title}</AlertTitle>
              <AlertDescription>{known.body}</AlertDescription>
            </Alert>
          ) : error ? (
            <Alert variant="destructive" role="alert">
              <AlertTriangleIcon />
              <AlertTitle>Sign-in failed</AlertTitle>
              <AlertDescription>Something went wrong. Please try again.</AlertDescription>
            </Alert>
          ) : null}

          {unreachable ? (
            <Alert variant="destructive">
              <ServerCrashIcon />
              <AlertTitle>The API is not reachable</AlertTitle>
              <AlertDescription>
                Start the backend (<code className="font-mono">npm run dev</code> in <code className="font-mono">backend/</code>) and check{" "}
                <code className="font-mono">NEXT_PUBLIC_API_BASE_URL</code>.
              </AlertDescription>
            </Alert>
          ) : config && !config.googleConfigured ? (
            <Card className="border-dashed">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <TerminalIcon className="size-4" /> Google OAuth is not configured yet
                </CardTitle>
                <CardDescription>
                  Sign-in is disabled until the server has credentials. Set these in <code className="font-mono">backend/.env</code> and restart the
                  API:
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="space-y-1 font-mono text-xs">
                  {config.missingConfig.map((name) => (
                    <li key={name} className="rounded bg-muted px-2 py-1">
                      {name}=
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  Create an OAuth 2.0 Web client in Google Cloud Console and add{" "}
                  <code className="font-mono">http://localhost:4000/api/v1/auth/google/callback</code> as an authorised redirect URI. Full steps are in
                  the README.
                </p>
              </CardContent>
            </Card>
          ) : null}

          <GoogleButton
            next={next}
            label={isRegister ? "Register with Google" : "Continue with Google"}
            disabled={unreachable || !config?.googleConfigured}
          />

          {config && config.collegeEmailDomains.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Restricted to college accounts:{" "}
              {config.collegeEmailDomains.map((domain) => (
                <code key={domain} className="mr-1 rounded bg-muted px-1.5 py-0.5 font-mono">
                  @{domain}
                </code>
              ))}
            </p>
          ) : null}

          <p className="text-sm text-muted-foreground">
            {isRegister ? (
              <>
                Already registered?{" "}
                <Link href="/login" className="font-medium text-foreground underline underline-offset-4">
                  Sign in
                </Link>
              </>
            ) : (
              <>
                New here?{" "}
                <Link href="/register" className="font-medium text-foreground underline underline-offset-4">
                  Register
                </Link>
              </>
            )}
          </p>
        </div>
      </section>
    </div>
  );
}
