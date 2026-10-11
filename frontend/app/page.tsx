import { ArrowRightIcon, LockIcon, RadioIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { getSession } from "@/lib/auth";
import { cn } from "@/lib/utils";

const features = [
  { icon: ShieldCheckIcon, title: "Real PostgreSQL, sandboxed", body: "Queries run read-only in an isolated engine with strict time and row limits." },
  { icon: LockIcon, title: "Hidden test cases", body: "Your query is judged on fixtures you can’t see — no hard-coding the sample." },
  { icon: RadioIcon, title: "Live leaderboard", body: "Ranks update the moment a submission is scored. Qualification is final only when a round closes." },
];

export default async function Home() {
  const { session } = await getSession();
  if (session) redirect("/dashboard");
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="page-container flex h-14 items-center justify-between">
        <Logo />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/login" className={cn(buttonVariants({ variant: "outline" }))}>
            Sign in
          </Link>
        </div>
      </header>
      <main className="page-container flex flex-1 flex-col justify-center py-16">
        <p className="t-eyebrow">A story-driven SQL competition</p>
        <h1 className="t-display mt-4 max-w-3xl">Solve the case. One query at a time.</h1>
        <p className="mt-5 max-w-xl text-base text-muted-foreground">
          Three rounds, one mystery. Start with simple SELECTs, finish with CTEs and nested subqueries. Only the sharpest make it through each
          round.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/register" className={cn(buttonVariants({ size: "lg" }), "h-10 px-4")}>
            Register with Google <ArrowRightIcon />
          </Link>
          <Link href="/login" className={cn(buttonVariants({ size: "lg", variant: "outline" }), "h-10 px-4")}>
            I already have an account
          </Link>
        </div>
        <ul className="mt-16 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3">
          {features.map(({ icon: Icon, title, body }) => (
            <li key={title} className="bg-background p-5">
              <Icon className="size-4" />
              <h2 className="t-heading mt-3">{title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{body}</p>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
