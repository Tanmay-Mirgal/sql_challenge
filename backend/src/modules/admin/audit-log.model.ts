import { model, Schema, type Types } from "mongoose";

export interface IAuditLog {
  _id: Types.ObjectId;
  actorId?: Types.ObjectId | null;
  /** Free-form dotted action name, e.g. `round.finalize`, `challenge.publish`. */
  action: string;
  targetType?: string;
  targetId?: string;
  eventId?: Types.ObjectId | null;
  metadata?: Record<string, unknown>;
  requestId?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, required: true, maxlength: 100 },
    targetType: { type: String, maxlength: 60 },
    targetId: { type: String, maxlength: 100 },
    eventId: { type: Schema.Types.ObjectId, ref: "Event", default: null },
    metadata: { type: Schema.Types.Mixed },
    requestId: { type: String, maxlength: 80 },
    createdAt: { type: Date, required: true },
  },
  { timestamps: false, versionKey: false },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ eventId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });

export const AuditLog = model<IAuditLog>("AuditLog", auditLogSchema);
