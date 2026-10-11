import { describe, expect, it } from "vitest";
import { compareRankable, NEVER, rankResults, type Rankable } from "@/modules/leaderboard/ranking";
import { computeScore, isFullyCorrect } from "@/modules/scoring/scoring";

const policy = {
  version: 3,
  fullCorrectnessBonus: 10,
  timePenaltyIntervalSeconds: 60,
  timePenaltyPoints: 2,
  maxTimePenalty: 30,
};
const tests = (...passed: boolean[]) => passed.map((p) => ({ weight: 1, mandatory: true, passed: p }));

describe("computeScore", () => {
  it("awards base + bonus when every test passes", () => {
    const s = computeScore({ policy, maxScore: 100, tests: tests(true, true, true, true), elapsedSeconds: 0 });
    expect(s).toMatchObject({ baseScore: 100, fullCorrectnessBonus: 10, timePenalty: 0, finalScore: 110, scoringVersion: 3 });
  });

  it("gives proportional partial credit without the bonus", () => {
    const s = computeScore({ policy, maxScore: 100, tests: tests(true, true, false, false), elapsedSeconds: 0 });
    expect(s).toMatchObject({ baseScore: 50, fullCorrectnessBonus: 0, finalScore: 50 });
  });

  it("respects test weights and floors fractional base scores", () => {
    const weighted = [
      { weight: 1, mandatory: true, passed: true },
      { weight: 2, mandatory: true, passed: false },
    ];
    expect(computeScore({ policy, maxScore: 100, tests: weighted, elapsedSeconds: 0 }).baseScore).toBe(33);
  });

  it("awards nothing (and no negative scores) when no test passes", () => {
    const s = computeScore({ policy, maxScore: 100, tests: tests(false, false), elapsedSeconds: 99_999 });
    expect(s).toMatchObject({ baseScore: 0, fullCorrectnessBonus: 0, timePenalty: 0, finalScore: 0 });
  });

  it("applies the time penalty in whole intervals and caps it", () => {
    const at = (elapsedSeconds: number) => computeScore({ policy, maxScore: 100, tests: tests(true), elapsedSeconds });
    expect(at(0).timePenalty).toBe(0);
    expect(at(59).timePenalty).toBe(0);
    expect(at(60).timePenalty).toBe(2);
    expect(at(119).timePenalty).toBe(2);
    expect(at(120).timePenalty).toBe(4);
    expect(at(60 * 15).timePenalty).toBe(30); // exactly the cap
    expect(at(60 * 100).timePenalty).toBe(30); // capped
    expect(at(60 * 100).finalScore).toBe(80);
  });

  it("never drops below zero even with a harsh policy", () => {
    const harsh = { ...policy, fullCorrectnessBonus: 0, timePenaltyPoints: 1000, maxTimePenalty: 10_000 };
    const s = computeScore({ policy: harsh, maxScore: 10, tests: tests(true), elapsedSeconds: 600 });
    expect(s.finalScore).toBe(0);
  });

  it("treats negative elapsed time as zero (clock skew)", () => {
    expect(computeScore({ policy, maxScore: 100, tests: tests(true), elapsedSeconds: -500 }).timePenalty).toBe(0);
  });

  it("withholds the bonus if a mandatory test fails but allows it when only optional tests fail", () => {
    const mixed = [
      { weight: 1, mandatory: true, passed: true },
      { weight: 1, mandatory: false, passed: false },
    ];
    const s = computeScore({ policy, maxScore: 100, tests: mixed, elapsedSeconds: 0 });
    expect(s.fullCorrectnessBonus).toBe(10);
    expect(isFullyCorrect(mixed)).toBe(true);
    expect(isFullyCorrect(tests(true, false))).toBe(false);
    expect(isFullyCorrect(tests(false))).toBe(false);
  });

  it("is deterministic", () => {
    const input = { policy, maxScore: 100, tests: tests(true, false, true), elapsedSeconds: 1234 };
    expect(computeScore(input)).toEqual(computeScore(input));
  });
});

const d = (iso: string) => new Date(iso);
const r = (userId: string, score: number, achieved: string | null, submissions: number, registered = "2025-01-01T00:00:00Z"): Rankable => ({
  userId,
  score,
  achievedAt: achieved ? d(achieved) : null,
  submissionCount: submissions,
  registeredAt: d(registered),
});

describe("ranking", () => {
  const chain = ["earliest_achieved", "fewer_submissions"] as const;

  it("orders by score, then earliest achievement, then fewer submissions, then registration, then id", () => {
    const rows = [
      r("e", 50, "2025-01-01T10:00:00Z", 3, "2025-01-01T00:00:02Z"),
      r("a", 90, "2025-01-01T10:30:00Z", 4),
      r("b", 90, "2025-01-01T10:10:00Z", 9),
      r("c", 90, "2025-01-01T10:10:00Z", 2),
      r("d", 50, "2025-01-01T10:00:00Z", 3, "2025-01-01T00:00:01Z"),
      r("g", 50, "2025-01-01T10:00:00Z", 3, "2025-01-01T00:00:01Z"),
    ];
    const ranked = rankResults(rows, chain);
    expect(ranked.map((x) => x.userId)).toEqual(["c", "b", "a", "d", "g", "e"]);
    expect(ranked.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ranked.map((x) => x.separatedBy)).toEqual(["submission_count", "achieved_at", "score", "user_id", "registration_order", null]);
  });

  it("is independent of input order (no randomness, no insertion-order bias)", () => {
    const rows = Array.from({ length: 40 }, (_, i) => r(`u${i}`, (i * 7) % 5, i % 3 ? `2025-01-01T10:${String(i).padStart(2, "0")}:00Z` : null, i % 4));
    const baseline = rankResults(rows, chain).map((x) => x.userId);
    for (let k = 0; k < 20; k += 1) {
      const shuffled = [...rows].sort(() => Math.random() - 0.5);
      expect(rankResults(shuffled, chain).map((x) => x.userId)).toEqual(baseline);
    }
  });

  it("honours a configuration without the fewer-submissions tie-break", () => {
    const a = r("a", 10, "2025-01-01T10:00:00Z", 1, "2025-01-01T00:00:05Z");
    const b = r("b", 10, "2025-01-01T10:00:00Z", 9, "2025-01-01T00:00:01Z");
    expect(rankResults([a, b], ["earliest_achieved"]).map((x) => x.userId)).toEqual(["b", "a"]);
    expect(rankResults([a, b], chain).map((x) => x.userId)).toEqual(["a", "b"]);
  });

  it("ranks participants without a score after scorers and treats missing times as NEVER", () => {
    const scorer = r("s", 1, "2025-01-01T10:00:00Z", 1);
    const nothing = r("n", 0, null, 0);
    expect(compareRankable(scorer, nothing, chain).order).toBeLessThan(0);
    expect(NEVER.getTime()).toBeGreaterThan(Date.now());
  });
});
