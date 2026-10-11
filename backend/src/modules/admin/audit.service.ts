import type { Types } from "mongoose";
import { logger } from "@/utils/logger";
import { now } from "@/utils/clock";
import { AuditLog } from "./audit-log.model";

export interface AuditEntry {
  actorId?: Types.ObjectId | string | null;
  action: string;
  targetType?: string;
  targetId?: string | Types.ObjectId;
  eventId?: Types.ObjectId | string | null;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

/**
 * Append-only audit trail. Failure to write an audit record is logged loudly but
 * must never take down the request that triggered it — except where the caller
 * awaits and decides otherwise.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await AuditLog.create({
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ? String(entry.targetId) : undefined,
      eventId: entry.eventId ?? null,
      metadata: entry.metadata,
      requestId: entry.requestId,
      createdAt: now(),
    });
  } catch (error) {
    logger.error({ err: error, action: entry.action }, "failed to write audit log");
  }
}
