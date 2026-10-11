import { CheckCircle2Icon, XCircleIcon } from "lucide-react";
import { Fragment } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { LeaderboardEntry } from "@/types/api";

export function LeaderboardTable({
  entries,
  meId,
  cutoff,
  finalized,
  compact = false,
  pinnedMe,
  caption,
}: {
  entries: LeaderboardEntry[];
  meId?: string;
  cutoff?: number | null;
  finalized?: boolean;
  compact?: boolean;
  /** The participant's own row when they are outside the visible page. */
  pinnedMe?: LeaderboardEntry | null;
  caption?: string;
}) {
  const meInPage = meId ? entries.some((entry) => entry.participantId === meId) : false;
  const showPinned = pinnedMe && !meInPage;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr className="border-b text-left text-[0.68rem] uppercase tracking-wider text-muted-foreground">
            <th scope="col" className="w-14 px-3 py-2 font-medium">
              Rank
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Participant
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Score
            </th>
            {!compact ? (
              <>
                <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">
                  Solved
                </th>
                <th scope="col" className="hidden px-3 py-2 text-right font-medium md:table-cell">
                  Reached at
                </th>
                <th scope="col" className="hidden px-3 py-2 text-right font-medium md:table-cell">
                  Tries
                </th>
              </>
            ) : null}
            <th scope="col" className="w-10 px-3 py-2 text-right font-medium">
              <span className="sr-only">Qualification</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => {
            const next = entries[index + 1];
            const crossesCutoff = cutoff != null && entry.rank === cutoff && next !== undefined;
            return (
              <Fragment key={entry.participantId}>
                <Row entry={entry} isMe={entry.participantId === meId} compact={compact} finalized={finalized} />
                {crossesCutoff ? (
                  <tr aria-hidden="true">
                    <td colSpan={compact ? 4 : 7} className="p-0">
                      <div className="relative my-0.5 border-t border-dashed border-foreground/40">
                        <span className="absolute -top-2 left-3 bg-background px-1.5 font-mono text-[0.62rem] uppercase tracking-wider text-muted-foreground">
                          Qualification cut-off · top {cutoff}
                        </span>
                      </div>
                      <div className="h-3" />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
          {showPinned ? (
            <>
              <tr aria-hidden="true">
                <td colSpan={compact ? 4 : 7} className="py-1 text-center text-muted-foreground">
                  ⋯
                </td>
              </tr>
              <Row entry={pinnedMe} isMe compact={compact} finalized={finalized} />
            </>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function Row({ entry, isMe, compact, finalized }: { entry: LeaderboardEntry; isMe: boolean; compact: boolean; finalized?: boolean }) {
  return (
    <tr
      className={cn("border-b border-border/60 transition-colors last:border-0", isMe && "bg-foreground/[0.06] font-medium")}
      aria-current={isMe ? "true" : undefined}
    >
      <td className="tabular px-3 py-2.5 font-mono text-sm">{entry.rank}</td>
      <td className="px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar size="sm">
            {entry.picture ? <AvatarImage src={entry.picture} alt="" referrerPolicy="no-referrer" /> : null}
            <AvatarFallback>{initials(entry.name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate leading-tight">
              {entry.name}
              {isMe ? <span className="ml-1.5 rounded bg-foreground px-1 py-0.5 text-[0.6rem] font-semibold uppercase text-background">You</span> : null}
            </p>
            {entry.department ? <p className="truncate text-xs font-normal text-muted-foreground">{entry.department}</p> : null}
          </div>
        </div>
      </td>
      <td className="tabular px-3 py-2.5 text-right font-mono">{entry.score}</td>
      {!compact ? (
        <>
          <td className="tabular hidden px-3 py-2.5 text-right sm:table-cell">{entry.challengesSolved}</td>
          <td className="tabular hidden px-3 py-2.5 text-right text-xs text-muted-foreground md:table-cell">{entry.achievedAt ? formatTime(entry.achievedAt) : "—"}</td>
          <td className="tabular hidden px-3 py-2.5 text-right text-xs text-muted-foreground md:table-cell">{entry.submissionCount}</td>
        </>
      ) : null}
      <td className="px-3 py-2.5 text-right">
        <QualificationMark entry={entry} finalized={finalized} />
      </td>
    </tr>
  );
}

function QualificationMark({ entry, finalized }: { entry: LeaderboardEntry; finalized?: boolean }) {
  if (entry.qualification === "qualified")
    return (
      <span title="Qualified" className="text-success">
        <CheckCircle2Icon className="ml-auto size-4" />
        <span className="sr-only">Qualified</span>
      </span>
    );
  if (entry.qualification === "eliminated" && finalized)
    return (
      <span title="Eliminated" className="text-muted-foreground">
        <XCircleIcon className="ml-auto size-4" />
        <span className="sr-only">Eliminated</span>
      </span>
    );
  if (!finalized && entry.inQualifyingPosition)
    return (
      <span className="font-mono text-[0.62rem] uppercase tracking-wider text-success" title="Inside the qualifying positions (provisional)">
        in
      </span>
    );
  return null;
}
