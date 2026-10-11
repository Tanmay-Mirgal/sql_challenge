import { ArrowRightIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { Countdown } from "@/components/dashboard/countdown";
import { buttonVariants } from "@/components/ui/button";
import { AccessBadge, PhaseLabel } from "@/components/ui/status-badge";
import { formatDateTime, ordinal } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ParticipantRound } from "@/types/api";

const lockedCopy: Record<string, string> = {
  not_registered: "Register for the event to unlock this round.",
  previous_round_pending: "Opens once the previous round is finalized.",
  not_qualified: "You did not qualify for this round.",
  not_published: "This round hasn’t been published yet.",
  disqualified: "You have been disqualified from this event.",
  account_disabled: "Your account cannot take part.",
};

const difficultyLabel = { basic: "Basic", intermediate: "Intermediate", advanced: "Advanced" } as const;

export function RoundCard({
  round,
  serverTime,
  onCountdownElapsed,
}: {
  round: ParticipantRound;
  serverTime: string;
  onCountdownElapsed: () => void;
}) {
  const canEnter = (round.phase === "open" || round.phase === "paused") && (round.access === "available" || round.access === "in_progress");
  const canReview = round.phase === "closed" || round.phase === "finalized";
  const locked = round.access === "locked";
  const gate =
    round.qualification.topN !== null ? `Top ${round.qualification.topN} advance` : round.number === 3 ? "Final round" : null;

  return (
    <article
      aria-labelledby={`round-${round.number}-title`}
      className={cn(
        "flex flex-col rounded-xl border bg-card p-5 text-card-foreground transition-colors",
        locked && "bg-muted/30",
        round.phase === "open" && "border-foreground/40",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-muted-foreground">ROUND {String(round.number).padStart(2, "0")}</p>
          <h3 id={`round-${round.number}-title`} className="t-heading mt-1 text-lg">
            {difficultyLabel[round.difficulty]}
          </h3>
        </div>
        <AccessBadge value={round.access} />
      </div>

      <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">{round.storyChapter || round.description}</p>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <dt className="t-eyebrow">Window</dt>
          <dd className="mt-0.5 tabular text-xs">
            {round.startsAt ? formatDateTime(round.startsAt) : "TBA"}
            {round.endsAt ? ` → ${formatDateTime(round.endsAt)}` : ""}
          </dd>
        </div>
        <div>
          <dt className="t-eyebrow">Status</dt>
          <dd className="mt-0.5">
            <PhaseLabel phase={round.phase} />
          </dd>
        </div>
        {gate ? (
          <div className="col-span-2">
            <dt className="t-eyebrow">Qualification</dt>
            <dd className="mt-0.5 text-xs">{gate}</dd>
          </div>
        ) : null}
      </dl>

      {round.me ? (
        <div className="mt-4 grid grid-cols-3 gap-2 rounded-lg bg-muted/60 p-3 text-center">
          <Stat label="Score" value={round.me.score} />
          <Stat label={round.me.qualification === "pending" ? "Rank (live)" : "Final rank"} value={round.me.finalRank ?? round.me.rank} prefix="#" />
          <Stat label="Submissions" value={round.me.submissionCount} />
        </div>
      ) : null}

      {round.countdown ? (
        <Countdown
          className="mt-4"
          target={round.countdown.at}
          serverTime={serverTime}
          label={round.countdown.kind === "starts" ? "Starts in" : "Ends in"}
          onElapsed={onCountdownElapsed}
        />
      ) : null}

      <div className="mt-auto pt-5">
        {locked ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <LockIcon className="size-3.5 shrink-0" />
            {lockedCopy[round.lockedReason ?? ""] ?? "This round is locked."}
          </p>
        ) : canEnter ? (
          <Link href={`/challenge/${round.id}`} className={cn(buttonVariants({ size: "lg" }), "h-9 w-full")}>
            {round.access === "available" ? "Start challenge" : "Continue"} <ArrowRightIcon />
          </Link>
        ) : canReview ? (
          <Link href={`/results?round=${round.number}`} className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-9 w-full")}>
            {round.access === "qualified" ? "You qualified — view result" : "View result"}
          </Link>
        ) : (
          <p className="text-xs text-muted-foreground">
            {round.me?.rank ? `Provisional rank ${ordinal(round.me.rank)}. ` : ""}
            {round.phase === "paused" ? "The round is paused. Submissions resume shortly." : "Challenges unlock when the round opens."}
          </p>
        )}
      </div>
    </article>
  );
}

function Stat({ label, value, prefix = "" }: { label: string; value: number | null; prefix?: string }) {
  return (
    <div>
      <p className="tabular text-lg font-semibold leading-none">{value === null ? "—" : `${prefix}${value}`}</p>
      <p className="mt-1 text-[0.65rem] uppercase tracking-wider text-muted-foreground">{label}</p>
    </div>
  );
}
