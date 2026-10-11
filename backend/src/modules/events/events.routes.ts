import { Router } from "express";
import { requireAuth } from "@/middleware/auth";
import { buildDashboard, buildParticipantRounds } from "@/modules/rounds/participant-view";
import { loadRoundContext } from "@/modules/rounds/round-context";
import { createRoundChallengesHandler } from "@/modules/challenges/challenges.routes";
import { eventLeaderboardHandler, eventResultsHandler, myResultsHandler, roundLeaderboardHandler } from "@/modules/leaderboard/leaderboard.routes";
import { Errors } from "@/utils/errors";
import { ok } from "@/utils/http";
import { recordAudit } from "@/modules/admin/audit.service";
import { EventModel } from "./event.model";
import { getActiveEvent, getEventOrThrow, getRegistration, registerForEvent, toEventDto } from "./events.service";

/** Participant-facing event endpoints. */
export function createEventsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/active", async (req, res) => {
    const event = await getActiveEvent();
    if (!event) return ok(res, { event: null, registration: null });
    const registration = await getRegistration(event._id, req.auth!.user._id);
    ok(res, {
      event: toEventDto(event),
      registration: registration ? { status: registration.status, registeredAt: registration.registeredAt } : null,
    });
  });

  router.get("/", async (_req, res) => {
    const events = await EventModel.find({ status: { $ne: "draft" } }).sort({ createdAt: -1 }).limit(50);
    ok(res, { events: events.map((event) => toEventDto(event)) });
  });

  router.get("/:eventId", async (req, res) => {
    const event = await getEventOrThrow(String(req.params.eventId));
    if (event.status === "draft") throw Errors.notFound("Event not found.", "EVENT_NOT_FOUND");
    ok(res, { event: toEventDto(event) });
  });

  router.get("/:eventId/rounds", async (req, res) => {
    const event = await getEventOrThrow(String(req.params.eventId));
    if (event.status === "draft") throw Errors.notFound("Event not found.", "EVENT_NOT_FOUND");
    const { views } = await buildParticipantRounds(req.auth!.user, event);
    ok(res, { rounds: views });
  });

  router.get("/:eventId/leaderboard", eventLeaderboardHandler);
  router.get("/:eventId/results", eventResultsHandler);

  router.post("/:eventId/register", async (req, res) => {
    const user = req.auth!.user;
    const registration = await registerForEvent(user, String(req.params.eventId));
    await recordAudit({ actorId: user.id, action: "event.register", targetType: "event", targetId: String(req.params.eventId), requestId: String(req.id) });
    res.status(201).json({ data: { registration: { status: registration.status, registeredAt: registration.registeredAt } } });
  });

  return router;
}

/** `/me/dashboard` — aggregate view for the signed-in participant. */
export function createDashboardRouter(): Router {
  const router = Router();
  router.get("/results", requireAuth, myResultsHandler);
  router.get("/dashboard", requireAuth, async (req, res) => {
    const event = await getActiveEvent();
    if (!event) return ok(res, { dashboard: null });
    ok(res, { dashboard: await buildDashboard(req.auth!.user, event) });
  });
  return router;
}

export function createRoundStatusRouter(): Router {
  const router = Router();
  router.use(requireAuth);
  router.get("/:roundId/challenges", createRoundChallengesHandler());
  router.get("/:roundId/leaderboard", roundLeaderboardHandler);
  router.get("/:roundId/status", async (req, res) => {
    const ctx = await loadRoundContext(String(req.params.roundId));
    if (ctx.event.status === "draft") throw Errors.notFound("Round not found.", "ROUND_NOT_FOUND");
    const { views } = await buildParticipantRounds(req.auth!.user, ctx.event, ctx.now);
    const view = views.find((candidate) => candidate.id === ctx.round.id);
    if (!view) throw Errors.notFound("Round not found.", "ROUND_NOT_FOUND");
    ok(res, { round: view, serverTime: ctx.now });
  });
  return router;
}
