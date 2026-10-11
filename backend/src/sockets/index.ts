import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { AppConfig } from "@/config";
import { getLeaderboardPage } from "@/modules/leaderboard/leaderboard.service";
import { Registration } from "@/modules/events/event.model";
import { resolveSession } from "@/modules/auth/session.service";
import { loadRoundContext } from "@/modules/rounds/round-context";
import { EventModel } from "@/modules/events/event.model";
import type { UserDocument } from "@/modules/users/user.model";
import { AppError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { SOCKET_EVENTS, type SocketAck, subscribeSchema } from "./events";
import type {
  AdminActivityPayload,
  EventUpdatedPayload,
  ParticipantUpdatedPayload,
  Realtime,
  RoundUpdatedPayload,
  SubmissionUpdatedPayload,
} from "./realtime";

interface SocketUser {
  id: string;
  publicId: string;
  role: "participant" | "admin";
}

declare module "socket.io" {
  interface SocketData {
    user: SocketUser;
    sessionToken: string;
    sessionHash?: string;
    events: number[];
  }
}

const LEADERBOARD_LIMIT = 50;
const BROADCAST_DEBOUNCE_MS = 400;
const BROADCAST_MAX_WAIT_MS = 1200;
const SESSION_RECHECK_MS = 60_000;
const MAX_EVENTS_PER_WINDOW = 30;
const WINDOW_MS = 10_000;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

export class SocketRealtime implements Realtime {
  readonly io: Server;
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; first: number }>();
  private recheckTimer: NodeJS.Timeout | undefined;

  constructor(
    httpServer: HttpServer,
    private readonly config: AppConfig,
  ) {
    this.io = new Server(httpServer, {
      cors: { origin: config.allowedOrigins, credentials: true },
      // Browsers always send Origin on WebSocket upgrades: refuse foreign pages outright.
      allowRequest: (req, callback) => {
        const origin = req.headers.origin;
        callback(null, !origin || config.allowedOrigins.includes(origin));
      },
      maxHttpBufferSize: 10_000,
      pingInterval: 20_000,
      pingTimeout: 20_000,
      serveClient: false,
    });
    this.io.use((socket, next) => {
      this.authenticate(socket).then(() => next(), (error: unknown) => next(error instanceof Error ? error : new Error("unauthorized")));
    });
    this.io.on("connection", (socket) => this.onConnection(socket));
    this.recheckTimer = setInterval(() => void this.recheckSessions(), SESSION_RECHECK_MS);
    this.recheckTimer.unref();
  }

  // --- connection lifecycle ------------------------------------------------------------------

  private async authenticate(socket: Socket): Promise<void> {
    const token = parseCookies(socket.handshake.headers.cookie)[this.config.session.cookieName];
    if (!token || token.length > 200) throw new Error("unauthorized");
    const resolved = await resolveSession(this.config, token);
    if (!resolved) throw new Error("unauthorized");
    const user: UserDocument = resolved.user;
    socket.data.user = { id: user.id as string, publicId: user.publicId, role: user.role };
    socket.data.sessionToken = token;
    socket.data.events = [];
  }

  private onConnection(socket: Socket): void {
    const user = socket.data.user;
    // Participant-specific updates travel on a room the server chose — never on a client-supplied name.
    void socket.join(`user:${user.id}`);

    socket.use((_packet, next) => {
      const now = Date.now();
      socket.data.events = socket.data.events.filter((t: number) => now - t < WINDOW_MS);
      if (socket.data.events.length >= MAX_EVENTS_PER_WINDOW) return next(new Error("rate_limited"));
      socket.data.events.push(now);
      return next();
    });

    socket.on("subscribe", (payload: unknown, ack?: (response: SocketAck) => void) => {
      void this.handleSubscribe(socket, payload, true).then((response) => ack?.(response));
    });
    socket.on("unsubscribe", (payload: unknown, ack?: (response: SocketAck) => void) => {
      void this.handleSubscribe(socket, payload, false).then((response) => ack?.(response));
    });
    logger.debug({ userId: user.id }, "socket connected");
  }

  private async stillValid(socket: Socket): Promise<boolean> {
    const resolved = await resolveSession(this.config, socket.data.sessionToken);
    return resolved !== null;
  }

  private async handleSubscribe(socket: Socket, payload: unknown, join: boolean): Promise<SocketAck> {
    try {
      const parsed = subscribeSchema.safeParse(payload);
      if (!parsed.success) return { ok: false, code: "INVALID_REQUEST", message: "Invalid subscription request." };
      if (!(await this.stillValid(socket))) {
        socket.disconnect(true);
        return { ok: false, code: "UNAUTHENTICATED", message: "Your session has ended." };
      }
      const { channel, id } = parsed.data;
      const user = socket.data.user;

      if (channel === "admin") {
        if (user.role !== "admin") return { ok: false, code: "FORBIDDEN", message: "Administrator access is required." };
        if (join) await socket.join("admin");
        else await socket.leave("admin");
        return { ok: true };
      }
      if (!id) return { ok: false, code: "INVALID_REQUEST", message: "An id is required." };

      if (channel === "event") {
        const event = await EventModel.findById(id);
        if (!event || (event.status === "draft" && user.role !== "admin")) return { ok: false, code: "NOT_FOUND", message: "Event not found." };
        if (user.role !== "admin" && !(await Registration.exists({ eventId: event._id, userId: user.id, status: { $ne: "withdrawn" } }))) {
          return { ok: false, code: "NOT_REGISTERED", message: "Register for the event to receive its updates." };
        }
        if (join) await socket.join(`event:${event.id}`);
        else await socket.leave(`event:${event.id}`);
        return { ok: true };
      }

      // channel === "round": live leaderboard for one round
      const ctx = await loadRoundContext(id);
      if (ctx.phase.phase === "draft" || (ctx.event.status === "draft" && user.role !== "admin")) {
        return { ok: false, code: "NOT_FOUND", message: "Round not found." };
      }
      if (user.role !== "admin" && !(await Registration.exists({ eventId: ctx.event._id, userId: user.id, status: { $ne: "withdrawn" } }))) {
        return { ok: false, code: "NOT_REGISTERED", message: "Register for the event to watch its leaderboard." };
      }
      if (!join) {
        await socket.leave(`round:${ctx.round.id}`);
        return { ok: true };
      }
      await socket.join(`round:${ctx.round.id}`);
      // Fresh snapshot on every (re)subscription: this is how clients resynchronise after a reconnect.
      const page = await getLeaderboardPage(ctx.round, ctx.event, { limit: LEADERBOARD_LIMIT, forUserId: user.id, fresh: true });
      socket.emit(SOCKET_EVENTS.leaderboardSnapshot, page);
      return { ok: true, snapshot: { seq: page.seq } };
    } catch (error) {
      if (error instanceof AppError) return { ok: false, code: error.code, message: error.message };
      logger.error({ err: error }, "socket subscribe failed");
      return { ok: false, code: "INTERNAL_ERROR", message: "Could not process the request." };
    }
  }

  /** Drop sockets whose session was revoked (logout elsewhere, suspension) or expired. */
  private async recheckSessions(): Promise<void> {
    try {
      for (const socket of await this.io.fetchSockets()) {
        const token = (socket.data as { sessionToken?: string }).sessionToken;
        if (!token) continue;
        const resolved = await resolveSession(this.config, token);
        if (!resolved) socket.disconnect(true);
      }
    } catch (error) {
      logger.warn({ err: error }, "socket session recheck failed");
    }
  }

  userSignedOut(userId: string): void {
    this.io.in(`user:${userId}`).disconnectSockets(true);
  }

  // --- Realtime port ---------------------------------------------------------------------------

  leaderboardChanged(roundId: string): void {
    const entry = this.pending.get(roundId);
    const now = Date.now();
    if (entry) {
      clearTimeout(entry.timer);
      const wait = Math.max(0, Math.min(BROADCAST_DEBOUNCE_MS, entry.first + BROADCAST_MAX_WAIT_MS - now));
      entry.timer = setTimeout(() => void this.flush(roundId), wait);
      return;
    }
    this.pending.set(roundId, { first: now, timer: setTimeout(() => void this.flush(roundId), BROADCAST_DEBOUNCE_MS) });
  }

  private async flush(roundId: string): Promise<void> {
    this.pending.delete(roundId);
    try {
      const room = `round:${roundId}`;
      if ((this.io.sockets.adapter.rooms.get(room)?.size ?? 0) === 0) return; // nobody is watching
      const ctx = await loadRoundContext(roundId);
      const { me: _me, ...page } = await getLeaderboardPage(ctx.round, ctx.event, { limit: LEADERBOARD_LIMIT, fresh: true });
      this.io.to(room).emit(SOCKET_EVENTS.leaderboardUpdated, page);
    } catch (error) {
      logger.warn({ err: error, roundId }, "leaderboard broadcast failed");
    }
  }

  roundUpdated(payload: RoundUpdatedPayload): void {
    this.io.to(`event:${payload.eventId}`).emit(SOCKET_EVENTS.roundUpdated, payload);
  }
  eventUpdated(payload: EventUpdatedPayload): void {
    this.io.to(`event:${payload.eventId}`).emit(SOCKET_EVENTS.eventUpdated, payload);
  }
  submissionUpdated(userId: string, payload: SubmissionUpdatedPayload): void {
    this.io.to(`user:${userId}`).emit(SOCKET_EVENTS.submissionUpdated, payload);
  }
  participantUpdated(userId: string, payload: ParticipantUpdatedPayload): void {
    this.io.to(`user:${userId}`).emit(SOCKET_EVENTS.participantUpdated, payload);
  }
  adminActivity(payload: AdminActivityPayload): void {
    this.io.to("admin").emit(SOCKET_EVENTS.adminActivity, payload);
  }

  async close(): Promise<void> {
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    await new Promise<void>((resolve) => void this.io.close(() => resolve()));
  }
}

