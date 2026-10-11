import { Router } from "express";
import { z } from "zod";
import { EventModel, Registration, REGISTRATION_STATUSES } from "@/modules/events/event.model";
import { transitionEventSchema, createEventSchema, updateEventSchema } from "@/modules/events/events.schema";
import {
  createEvent,
  getEventOrThrow,
  toEventDto,
  transitionEvent,
  updateEvent,
} from "@/modules/events/events.service";
import { loadRoundContext } from "@/modules/rounds/round-context";
import {
  applyRoundAction,
  listRounds,
  publishRoundUpdate,
  roundActionSchema,
  toAdminRoundDto,
  updateRound,
  updateRoundSchema,
} from "@/modules/rounds/rounds.service";
import { resolvePhase } from "@/modules/rounds/round-context";
import { User } from "@/modules/users/user.model";
import { destroyAllSessionsForUser } from "@/modules/auth/session.service";
import { realtime } from "@/sockets/realtime";
import { now } from "@/utils/clock";
import { Errors } from "@/utils/errors";
import { created, ok, objectIdParam, paginate, paginationMeta, paginationQuery } from "@/utils/http";
import { escapeRegex } from "@/utils/sanitize";
import { AuditLog } from "./audit-log.model";
import { recordAudit } from "./audit.service";

export function createAdminEventsRouter(): Router {
  const router = Router();

  // ---- events -------------------------------------------------------------------------------
  router.get("/events", async (req, res) => {
    const query = paginationQuery.parse(req.query);
    const { skip, limit } = paginate(query);
    const [events, total] = await Promise.all([
      EventModel.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      EventModel.countDocuments(),
    ]);
    ok(res, { events: events.map((event) => toEventDto(event, { includeAdminFields: true })) }, paginationMeta(query, total));
  });

  router.post("/events", async (req, res) => {
    const input = createEventSchema.parse(req.body);
    const event = await createEvent(req.auth!.user, input);
    await recordAudit({ actorId: req.auth!.user.id, action: "event.create", targetType: "event", targetId: event.id, eventId: event._id, requestId: String(req.id) });
    created(res, { event: toEventDto(event, { includeAdminFields: true }) });
  });

  router.get("/events/:eventId", async (req, res) => {
    const event = await getEventOrThrow(String(req.params.eventId));
    ok(res, { event: toEventDto(event, { includeAdminFields: true }) });
  });

  router.patch("/events/:eventId", async (req, res) => {
    const patch = updateEventSchema.parse(req.body);
    const event = await updateEvent(String(req.params.eventId), patch);
    await recordAudit({
      actorId: req.auth!.user.id,
      action: "event.update",
      targetType: "event",
      targetId: event.id,
      eventId: event._id,
      metadata: { fields: Object.keys(patch), scoringVersion: event.scoring.version },
      requestId: String(req.id),
    });
    ok(res, { event: toEventDto(event, { includeAdminFields: true }) });
  });

  router.post("/events/:eventId/transition", async (req, res) => {
    const { to } = transitionEventSchema.parse(req.body);
    const before = await getEventOrThrow(String(req.params.eventId));
    const from = before.status;
    const event = await transitionEvent(String(req.params.eventId), to);
    await recordAudit({
      actorId: req.auth!.user.id,
      action: "event.transition",
      targetType: "event",
      targetId: event.id,
      eventId: event._id,
      metadata: { from, to },
      requestId: String(req.id),
    });
    realtime.eventUpdated({ eventId: event.id as string, status: event.status, at: now().toISOString() });
    ok(res, { event: toEventDto(event, { includeAdminFields: true }) });
  });

  // ---- rounds -------------------------------------------------------------------------------
  router.get("/events/:eventId/rounds", async (req, res) => {
    const event = await getEventOrThrow(String(req.params.eventId));
    const rounds = await listRounds(event.id as string);
    const at = now();
    ok(res, {
      rounds: rounds.map((round) => {
        const previous = rounds.find((candidate) => candidate.number === round.number - 1) ?? null;
        return toAdminRoundDto(round, resolvePhase(event, round, previous, at));
      }),
    });
  });

  router.patch("/rounds/:roundId", async (req, res) => {
    const patch = updateRoundSchema.parse(req.body);
    const ctx = await updateRound(String(req.params.roundId), patch);
    await recordAudit({
      actorId: req.auth!.user.id,
      action: "round.update",
      targetType: "round",
      targetId: ctx.round.id,
      eventId: ctx.event._id,
      metadata: { fields: Object.keys(patch) },
      requestId: String(req.id),
    });
    publishRoundUpdate(ctx);
    ok(res, { round: toAdminRoundDto(ctx.round, ctx.phase) });
  });

  router.post("/rounds/:roundId/actions", async (req, res) => {
    const { action, extendByPausedTime } = roundActionSchema.parse(req.body);
    const ctx = await applyRoundAction(String(req.params.roundId), action, { extendByPausedTime });
    await recordAudit({
      actorId: req.auth!.user.id,
      action: `round.${action}`,
      targetType: "round",
      targetId: ctx.round.id,
      eventId: ctx.event._id,
      requestId: String(req.id),
    });
    ok(res, { round: toAdminRoundDto(ctx.round, ctx.phase) });
  });

  router.get("/rounds/:roundId", async (req, res) => {
    const ctx = await loadRoundContext(String(req.params.roundId));
    ok(res, { round: toAdminRoundDto(ctx.round, ctx.phase) });
  });

  // ---- participants -------------------------------------------------------------------------
  const participantsQuery = paginationQuery.extend({
    q: z.string().trim().max(100).optional(),
    status: z.enum(REGISTRATION_STATUSES).optional(),
  });

  router.get("/events/:eventId/participants", async (req, res) => {
    const event = await getEventOrThrow(String(req.params.eventId));
    const query = participantsQuery.parse(req.query);
    const filter: Record<string, unknown> = { eventId: event._id };
    if (query.status) filter.status = query.status;
    if (query.q) {
      const pattern = new RegExp(escapeRegex(query.q), "i");
      const users = await User.find({ $or: [{ name: pattern }, { email: pattern }, { rollNumber: pattern }] }).select("_id").limit(500);
      filter.userId = { $in: users.map((user) => user._id) };
    }
    const { skip, limit } = paginate(query);
    const [registrations, total] = await Promise.all([
      Registration.find(filter).sort({ registeredAt: 1 }).skip(skip).limit(limit),
      Registration.countDocuments(filter),
    ]);
    const users = await User.find({ _id: { $in: registrations.map((r) => r.userId) } });
    const byId = new Map(users.map((user) => [user.id as string, user]));
    ok(
      res,
      {
        participants: registrations.map((registration) => {
          const user = byId.get(String(registration.userId));
          return {
            userId: String(registration.userId),
            name: user?.name ?? "—",
            email: user?.email ?? "—",
            department: user?.department ?? null,
            rollNumber: user?.rollNumber ?? null,
            collegeStatus: user?.collegeStatus ?? null,
            accountStatus: user?.status ?? null,
            registrationStatus: registration.status,
            registeredAt: registration.registeredAt,
            disqualifiedReason: registration.disqualifiedReason ?? null,
          };
        }),
      },
      paginationMeta(query, total),
    );
  });

  const moderationSchema = z.strictObject({
    status: z.enum(["registered", "disqualified"]),
    reason: z.string().trim().max(500).optional(),
  });

  router.patch("/events/:eventId/participants/:userId", async (req, res) => {
    const event = await getEventOrThrow(String(req.params.eventId));
    const userId = objectIdParam.parse(req.params.userId);
    const input = moderationSchema.parse(req.body);
    if (input.status === "disqualified" && !input.reason) throw Errors.badRequest("A reason is required to disqualify a participant.");
    const registration = await Registration.findOne({ eventId: event._id, userId });
    if (!registration) throw Errors.notFound("Participant not found.", "PARTICIPANT_NOT_FOUND");
    registration.status = input.status;
    registration.disqualifiedReason = input.status === "disqualified" ? (input.reason ?? null) : null;
    await registration.save();
    await recordAudit({
      actorId: req.auth!.user.id,
      action: `participant.${input.status === "disqualified" ? "disqualify" : "reinstate"}`,
      targetType: "user",
      targetId: userId,
      eventId: event._id,
      metadata: { reason: input.reason },
      requestId: String(req.id),
    });
    ok(res, { registration: { userId, status: registration.status, reason: registration.disqualifiedReason ?? null } });
  });

  // ---- accounts -----------------------------------------------------------------------------
  const accountStatusSchema = z.strictObject({ status: z.enum(["active", "suspended", "banned"]) });
  router.patch("/users/:userId/status", async (req, res) => {
    const userId = objectIdParam.parse(req.params.userId);
    const { status } = accountStatusSchema.parse(req.body);
    const target = await User.findById(userId);
    if (!target) throw Errors.notFound("User not found.", "USER_NOT_FOUND");
    if (target.role === "admin" && status !== "active") {
      throw Errors.conflict("Administrators cannot be suspended here.", "CANNOT_SUSPEND_ADMIN");
    }
    target.status = status;
    await target.save();
    if (status !== "active") {
      await destroyAllSessionsForUser(userId);
      realtime.userSignedOut(userId);
    }
    await recordAudit({ actorId: req.auth!.user.id, action: "user.status", targetType: "user", targetId: userId, metadata: { status }, requestId: String(req.id) });
    ok(res, { user: { id: userId, status } });
  });

  // ---- audit trail --------------------------------------------------------------------------
  const auditQuery = paginationQuery.extend({
    eventId: objectIdParam.optional(),
    action: z.string().trim().max(100).optional(),
  });
  router.get("/audit-logs", async (req, res) => {
    const query = auditQuery.parse(req.query);
    const filter: Record<string, unknown> = {};
    if (query.eventId) filter.eventId = query.eventId;
    if (query.action) filter.action = query.action;
    const { skip, limit } = paginate(query);
    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);
    const actorIds = logs.flatMap((log) => (log.actorId ? [log.actorId] : []));
    const actors = await User.find({ _id: { $in: actorIds } }).select("name email").lean<Array<{ _id: unknown; name: string; email: string }>>();
    const actorById = new Map(actors.map((actor) => [String(actor._id), actor]));
    ok(
      res,
      {
        logs: logs.map((log) => ({
          id: String(log._id),
          action: log.action,
          actor: log.actorId ? { id: String(log.actorId), name: actorById.get(String(log.actorId))?.name ?? "—" } : null,
          targetType: log.targetType ?? null,
          targetId: log.targetId ?? null,
          eventId: log.eventId ? String(log.eventId) : null,
          metadata: log.metadata ?? null,
          createdAt: log.createdAt,
        })),
      },
      paginationMeta(query, total),
    );
  });

  return router;
}
