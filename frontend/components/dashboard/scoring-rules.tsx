import { formatDuration } from "@/lib/format";
import type { ScoringPolicyDto } from "@/types/api";

/** Plain-language rendering of the published scoring policy so participants know the rules up front. */
export function ScoringRules({ scoring }: { scoring: ScoringPolicyDto }) {
  const interval = formatDuration(scoring.timePenaltyIntervalSeconds * 1000);
  const tieBreaks = [
    "higher score",
    ...(scoring.tieBreakers.includes("earliest_achieved") ? ["the earlier time the score was reached"] : []),
    ...(scoring.tieBreakers.includes("fewer_submissions") ? ["fewer submissions"] : []),
    "earlier registration",
  ];
  return (
    <ul className="space-y-2 text-sm text-muted-foreground">
      <li>
        Each challenge is worth up to <strong className="text-foreground">{scoring.maxScorePerChallenge} points</strong>, split across the hidden test cases you pass.
      </li>
      {scoring.fullCorrectnessBonus > 0 ? (
        <li>
          Passing every mandatory test adds a <strong className="text-foreground">+{scoring.fullCorrectnessBonus} bonus</strong>.
        </li>
      ) : null}
      {scoring.timePenaltyPoints > 0 ? (
        <li>
          Speed matters: <strong className="text-foreground">&minus;{scoring.timePenaltyPoints}</strong> for every {interval} since the round opened, up to a
          maximum of &minus;{scoring.maxTimePenalty} per challenge.
        </li>
      ) : null}
      <li>Only your best submission per challenge counts. Failed or timed-out queries earn no credit.</li>
      <li>
        Ties are broken by: {tieBreaks.join(" → ")}.
      </li>
      <li className="text-xs">Scoring policy v{scoring.version}. All times use the server clock.</li>
    </ul>
  );
}
