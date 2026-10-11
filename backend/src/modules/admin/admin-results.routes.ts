import { Router } from "express";
import { z } from "zod";
import { getEventOrThrow } from "@/modules/events/events.service";
import { finalizeRound } from "@/modules/leaderboard/qualification.service";
import { getEventStandings, getRoundRanking } from "@/modules/leaderboard/leaderboard.service";
import { NEVER } from "@/modules/leaderboard/ranking";
import { loadRoundContext } from "@/modules/rounds/round-context";
import { Round } from "@/modules/rounds/round.model";
import { toAdminRoundDto } from "@/modules/rounds/rounds.service";
import { User } from "@/modules/users/user.model";
import { toCsv } from "@/utils/sanitize";
import { ok, paginationQuery } from "@/utils/http";
import { recordAudit } from "./audit.service";

type RankingEntry = Awaited<ReturnType<typeof getRoundRanking>>["entries"][number];

async function usersFor(entries: RankingEntry[]) {
  const users = await User.find({ _id: { $in: entries.map((entry) => entry.row.userId) } }).lean();
  return new Map(users.map((user) => [String(user._id), user]));
}

export function createAdminResultsRouter(): Router {
  const router = Router();

  router.post("/rounds/:roundId/finalize", async (req, res) => {
    const { force } = z.strictObject({ force: z.boolean().optional() }).parse(req.body ?? {});
    const summary = await finalizeRound(String(req.params.roundId), req.auth!.user, { force });
    const ctx = await loadRoundContext(String(req.params.roundId));
    if (!summary.alreadyFinalized) {
      await recordAudit({
        actorId: req.auth!.user.id,
        action: "round.finalize",
        targetType: "round",
        targetId: summary.roundId,
        eventId: ctx.event._id,
        metadata: { participants: summary.participants, qualified: summary.qualified, snapshotHash: summary.snapshotHash, forced: force === true, idempotencyKey: req.header("idempotency-key") ?? null },
        requestId: String(req.id),
      });
    }
    ok(res, { summary, round: toAdminRoundDto(ctx.round, ctx.phase) });
  });

  /** Full ranking with private details (administrators only). */
  router.get("/rounds/:roundId/results", async (req, res) => {
    const query = paginationQuery.extend({ pageSize: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const ctx = await loadRoundContext(String(req.params.roundId));
    const ranking = await getRoundRanking(ctx.round, ctx.event, { fresh: true });
    const slice = ranking.entries.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
    const users = await usersFor(slice);
    ok(
      res,
      {
        finalized: ranking.finalized,
        entries: slice.map((entry) => {
          const user = users.get(entry.userId);
          return {
            rank: entry.rank,
            userId: entry.userId,
            name: user?.name ?? "—",
            email: user?.email ?? "—",
            department: user?.department ?? null,
            rollNumber: user?.rollNumber ?? null,
            score: entry.row.score,
            challengesSolved: entry.row.challengesSolved,
            submissionCount: entry.row.submissionCount,
            achievedAt: entry.row.achievedAt && entry.row.achievedAt.getTime() < NEVER.getTime() ? entry.row.achievedAt : null,
            qualification: entry.row.qualification.status,
            tieBreakApplied: entry.row.qualification.tieBreakApplied ?? entry.separatedBy ?? null,
          };
        }),
      },
      { page: query.page, pageSize: query.pageSize, total: ranking.entries.length, totalPages: Math.max(1, Math.ceil(ranking.entries.length / query.pageSize)) },
    );
  });

  router.get("/rounds/:roundId/results.csv", async (req, res) => {
    const ctx = await loadRoundContext(String(req.params.roundId));
    const ranking = await getRoundRanking(ctx.round, ctx.event, { fresh: true });
    const users = await usersFor(ranking.entries);
    const rows: unknown[][] = [["rank", "name", "email", "roll_number", "department", "score", "challenges_solved", "submissions", "reached_at", "qualification", "tie_break"]];
    for (const entry of ranking.entries) {
      const user = users.get(entry.userId);
      rows.push([
        entry.rank,
        user?.name,
        user?.email,
        user?.rollNumber,
        user?.department,
        entry.row.score,
        entry.row.challengesSolved,
        entry.row.submissionCount,
        entry.row.achievedAt && entry.row.achievedAt.getTime() < NEVER.getTime() ? entry.row.achievedAt : "",
        entry.row.qualification.status,
        entry.row.qualification.tieBreakApplied ?? entry.separatedBy ?? "",
      ]);
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="round-${ctx.round.number}-results.csv"`);
    res.send(toCsv(rows));
    await recordAudit({ actorId: req.auth!.user.id, action: "export.round_results", targetType: "round", targetId: ctx.round.id, eventId: ctx.event._id, requestId: String(req.id) });
  });

  router.get("/events/:eventId/results.csv", async (req, res) => {
    const event = await getEventOrThrow(String(req.params.eventId));
    const rounds = await Round.find({ eventId: event._id }).sort({ number: 1 });
    const standings = await getEventStandings(event, rounds, { limit: 200 });
    const all = [];
    for (let offset = 0; offset < standings.total; offset += 200) {
      all.push(...(await getEventStandings(event, rounds, { limit: 200, offset })).entries);
    }
    const users = await User.find({ publicId: { $in: all.map((entry) => entry.participantId) } }).lean();
    const byPublicId = new Map(users.map((user) => [user.publicId, user]));
    const header = ["overall_rank", "name", "email", "roll_number", "department", "reached_round", "total_score", ...rounds.flatMap((r) => [`r${r.number}_score`, `r${r.number}_rank`, `r${r.number}_status`])];
    const rows: unknown[][] = [header];
    for (const entry of all) {
      const user = byPublicId.get(entry.participantId);
      rows.push([
        entry.rank,
        entry.name,
        user?.email,
        user?.rollNumber,
        entry.department,
        entry.reachedRound,
        entry.totalScore,
        ...rounds.flatMap((r) => {
          const found = entry.rounds.find((x) => x.number === r.number);
          return [found?.score ?? "", found?.rank ?? "", found?.qualification ?? ""];
        }),
      ]);
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${event.slug}-final-results.csv"`);
    res.send(toCsv(rows));
    await recordAudit({ actorId: req.auth!.user.id, action: "export.event_results", targetType: "event", targetId: event.id, eventId: event._id, requestId: String(req.id) });
  });

  router.get("/events/:eventId/leaderboard", async (req, res) => {
    const event = await getEventOrThrow(String(req.params.eventId));
    const rounds = await Round.find({ eventId: event._id }).sort({ number: 1 });
    const query = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    ok(res, await getEventStandings(event, rounds, query));
  });

  return router;
}
