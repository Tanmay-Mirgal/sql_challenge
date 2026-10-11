import type { ScoringPolicy } from "@/modules/events/event.model";
import type { ScoreBreakdown } from "@/modules/submissions/submission.model";

export interface ScoredTest {
  weight: number;
  mandatory: boolean;
  passed: boolean;
}

export interface ScoreInput {
  policy: Pick<
    ScoringPolicy,
    "version" | "fullCorrectnessBonus" | "timePenaltyIntervalSeconds" | "timePenaltyPoints" | "maxTimePenalty"
  >;
  /** Points available for this challenge (event default or per-challenge override). */
  maxScore: number;
  tests: ScoredTest[];
  /** Seconds between the round's official start and the server-recorded submission time. */
  elapsedSeconds: number;
}

/**
 * Deterministic scoring. Pure function of its inputs — no clock, no I/O — so the
 * same submission always yields the same score and the rules can be audited.
 *
 *   baseScore   = floor(maxScore × passedWeight / totalWeight)
 *   bonus       = fullCorrectnessBonus when every mandatory test passed (and ≥1 test passed)
 *   timePenalty = min(maxTimePenalty, floor(elapsed / interval) × penaltyPoints)   [only if baseScore > 0]
 *   finalScore  = max(0, baseScore + bonus − timePenalty)
 *
 * The penalty is applied per challenge, measured from the round's official start.
 */
export function computeScore(input: ScoreInput): ScoreBreakdown {
  const { policy, maxScore, tests } = input;
  const elapsedSeconds = Math.max(0, Math.floor(input.elapsedSeconds));
  const totalWeight = tests.reduce((sum, test) => sum + test.weight, 0);
  const passedWeight = tests.reduce((sum, test) => sum + (test.passed ? test.weight : 0), 0);
  const baseScore = totalWeight > 0 ? Math.floor((maxScore * passedWeight) / totalWeight) : 0;

  const mandatory = tests.filter((test) => test.mandatory);
  const allMandatoryPassed = mandatory.every((test) => test.passed);
  const fullCorrectnessBonus = passedWeight > 0 && allMandatoryPassed ? policy.fullCorrectnessBonus : 0;

  const creditEarned = passedWeight > 0;
  const rawPenalty =
    policy.timePenaltyPoints > 0
      ? Math.floor(elapsedSeconds / Math.max(1, policy.timePenaltyIntervalSeconds)) * policy.timePenaltyPoints
      : 0;
  const timePenalty = creditEarned ? Math.min(policy.maxTimePenalty, rawPenalty) : 0;
  const finalScore = creditEarned ? Math.max(0, baseScore + fullCorrectnessBonus - timePenalty) : 0;

  return {
    scoringVersion: policy.version,
    maxScore,
    passedWeight,
    totalWeight,
    baseScore,
    fullCorrectnessBonus,
    elapsedSeconds,
    timePenalty,
    finalScore,
  };
}

/** A submission is "fully correct" when it earned credit and every mandatory test passed. */
export function isFullyCorrect(tests: ScoredTest[]): boolean {
  return tests.some((t) => t.passed) && tests.filter((t) => t.mandatory).every((t) => t.passed);
}
