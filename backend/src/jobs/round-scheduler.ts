import { publishRoundUpdate } from "@/modules/rounds/rounds.service";
import { loadRoundContext } from "@/modules/rounds/round-context";
import { desiredStatus } from "@/modules/rounds/round-state";
import { Round } from "@/modules/rounds/round.model";
import { logger } from "@/utils/logger";

/**
 * Persists schedule-driven round transitions (scheduled → active at the start time,
 * active → completed at the end time) and tells connected clients.
 *
 * Correctness never depends on this job: every access check derives the effective
 * phase from the clock, so a late or missed tick can only delay the *display* of a
 * persisted status, never grant or extend access.
 */
export async function reconcileRounds(): Promise<number> {
  const rounds = await Round.find({ status: { $in: ["scheduled", "active", "paused"] } }).select("_id status");
  let changed = 0;
  for (const candidate of rounds) {
    const ctx = await loadRoundContext(String(candidate._id));
    const target = desiredStatus(ctx.round.status, ctx.phase);
    if (target === ctx.round.status) continue;
    const result = await Round.updateOne({ _id: ctx.round._id, status: ctx.round.status }, { $set: { status: target, ...(target === "completed" ? { pausedAt: null } : {}) } });
    if (result.modifiedCount > 0) {
      changed += 1;
      logger.info({ roundId: String(ctx.round._id), from: ctx.round.status, to: target }, "round status advanced by schedule");
      publishRoundUpdate(await loadRoundContext(String(ctx.round._id)));
    }
  }
  return changed;
}

export function startRoundScheduler(intervalMs = 5000): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    reconcileRounds()
      .catch((error: unknown) => logger.error({ err: error }, "round scheduler tick failed"))
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

