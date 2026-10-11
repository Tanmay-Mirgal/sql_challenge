"use client";

import { ArrowUpRightIcon, CheckCircle2Icon, Loader2Icon, RefreshCwIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Countdown } from "@/components/dashboard/countdown";
import { RoundCard } from "@/components/dashboard/round-card";
import { ScoringRules } from "@/components/dashboard/scoring-rules";
import { LeaderboardTable } from "@/components/leaderboard/leaderboard-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, ApiError, errorMessage } from "@/lib/api-client";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import type { Dashboard, EventStatus, SelfUser } from "@/types/api";

const statusCopy: Record<EventStatus, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "bg-secondary text-secondary-foreground" },
  registration: { label: "Registration open", tone: "bg-info/15 text-info" },
  live: { label: "Live", tone: "bg-success/15 text-success" },
  paused: { label: "Paused", tone: "bg-warning/20 text-warning" },
  finalized: { label: "Finished", tone: "bg-secondary text-secondary-foreground" },
};

export function DashboardView({ initial, user }: { initial: Dashboard; user: SelfUser }) {
  const [dashboard, setDashboard] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [joining, setJoining] = useState(false);
  const storeUser = useAuthStore((state) => state.user) ?? user;

  const refresh = useCallback(async (silent = true) => {
    if (!silent) setRefreshing(true);
    try {
      const { dashboard: next } = await api.get<{ dashboard: Dashboard | null }>("/me/dashboard");
      if (next) setDashboard(next);
    } catch (error) {
      if (!silent) toast.error(errorMessage(error, "Could not refresh."));
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Polling fallback while a round is live; the live socket channel (see use-live-updates) pushes sooner.
  const anyLive = dashboard.rounds.some((round) => round.phase === "open");
  useEffect(() => {
    const id = window.setInterval(() => void refresh(true), anyLive ? 20_000 : 60_000);
    return () => window.clearInterval(id);
  }, [anyLive, refresh]);

  async function join() {
    setJoining(true);
    try {
      await api.post(`/events/${dashboard.event.id}/register`);
      toast.success("You’re in. Good luck!");
      await refresh(true);
    } catch (error) {
      if (error instanceof ApiError && error.code === "PROFILE_INCOMPLETE") {
        toast.error("Complete your profile first.");
      } else {
        toast.error(errorMessage(error, "Could not register."));
      }
    } finally {
      setJoining(false);
    }
  }

  const { event, registration, rounds, leaderboardPreview } = dashboard;
  const status = statusCopy[event.status];
  const canJoin = !registration && (event.status === "registration" || event.status === "live");
  const full = event.maxParticipants !== null && event.registeredCount >= event.maxParticipants;
  const nextRound = rounds.find((round) => round.countdown?.kind === "starts") ?? rounds.find((round) => round.countdown?.kind === "ends");

  return (
    <div className="page-container space-y-8 py-8">
      <section aria-labelledby="event-title" className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn("h-6 border-transparent px-2", status.tone)}>
              {event.status === "live" ? <span className="size-1.5 animate-pulse rounded-full bg-current" /> : null}
              {status.label}
            </Badge>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <UsersIcon className="size-3.5" />
              {event.registeredCount}
              {event.maxParticipants ? ` / ${event.maxParticipants}` : ""} participants
            </span>
          </div>
          <h1 id="event-title" className="t-display !text-3xl sm:!text-4xl">
            {event.name}
          </h1>
          {event.description ? <p className="text-sm text-muted-foreground">{event.description}</p> : null}
        </div>
        <div className="flex flex-col items-start gap-3 sm:items-end">
          {nextRound?.countdown ? (
            <Countdown
              target={nextRound.countdown.at}
              serverTime={dashboard.serverTime}
              label={`Round ${nextRound.number} ${nextRound.countdown.kind === "starts" ? "starts in" : "ends in"}`}
              onElapsed={() => void refresh(true)}
            />
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => void refresh(false)} disabled={refreshing}>
            {refreshing ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} Refresh
          </Button>
        </div>
      </section>

      <section aria-label="Your participation">
        {registration ? (
          registration.status === "disqualified" ? (
            <Alert variant="destructive">
              <AlertTitle>You have been disqualified</AlertTitle>
              <AlertDescription>Please contact the organisers if you believe this is a mistake.</AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3">
              <div className="flex items-center gap-3">
                <CheckCircle2Icon className="size-5 text-success" />
                <div>
                  <p className="text-sm font-medium">
                    You&apos;re registered{storeUser.department ? ` · ${storeUser.department}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">Joined {formatDate(registration.registeredAt)}</p>
                </div>
              </div>
              <Link href="/profile" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
                Edit profile
              </Link>
            </div>
          )
        ) : canJoin ? (
          <Card>
            <CardHeader>
              <CardTitle>Join the competition</CardTitle>
              <CardDescription>
                {dashboard.profile.complete
                  ? "Register now to unlock Round 1 when it opens."
                  : "This event needs a few more details on your profile before you can join."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {dashboard.profile.complete ? (
                <Button size="lg" className="h-9" onClick={join} disabled={joining || full}>
                  {joining ? <Loader2Icon className="animate-spin" /> : null} {full ? "Event full" : "Register for this event"}
                </Button>
              ) : (
                <Link href="/profile?from=dashboard" className={cn(buttonVariants({ size: "lg" }), "h-9")}>
                  Complete profile <ArrowUpRightIcon />
                </Link>
              )}
            </CardContent>
          </Card>
        ) : (
          <Alert>
            <AlertTitle>Registration is not open</AlertTitle>
            <AlertDescription>
              {event.status === "finalized"
                ? "This event has finished. Final results are available below."
                : "You can browse the event, but you must register while registration is open to take part."}
            </AlertDescription>
          </Alert>
        )}
      </section>

      <section aria-labelledby="rounds-title" className="space-y-3">
        <h2 id="rounds-title" className="t-heading">
          Rounds
        </h2>
        <div className="grid gap-4 lg:grid-cols-3">
          {rounds.map((round) => (
            <RoundCard key={round.id} round={round} serverTime={dashboard.serverTime} onCountdownElapsed={() => void refresh(true)} />
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>{leaderboardPreview ? `Leaderboard · ${leaderboardPreview.roundName ?? `Round ${leaderboardPreview.roundNumber}`}` : "Leaderboard"}</span>
              <Link href="/leaderboard" className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground">
                Full board <ArrowUpRightIcon className="size-3" />
              </Link>
            </CardTitle>
            <CardDescription>
              {leaderboardPreview?.finalized
                ? "Final standings."
                : "Provisional until the round is finalized — a high live rank does not unlock the next round."}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {leaderboardPreview && leaderboardPreview.entries.length > 0 ? (
              <LeaderboardTable
                compact
                entries={leaderboardPreview.entries}
                meId={storeUser.publicId}
                finalized={leaderboardPreview.finalized}
                pinnedMe={leaderboardPreview.me}
                caption="Top participants"
              />
            ) : (
              <p className="px-6 py-8 text-center text-sm text-muted-foreground">No scores yet. Be the first on the board.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Rules &amp; scoring</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {event.rules ? <p className="whitespace-pre-line text-sm text-muted-foreground">{event.rules}</p> : null}
            <ScoringRules scoring={event.scoring} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
