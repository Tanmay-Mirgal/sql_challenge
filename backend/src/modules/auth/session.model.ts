import { model, Schema, type Types } from "mongoose";

/**
 * Server-side session. The browser only ever holds a random bearer value in an
 * HttpOnly cookie; the database stores its SHA-256 hash, so a database leak
 * cannot be replayed as live sessions. Deleting the document invalidates the
 * session immediately (logout, suspension).
 */
export interface ISession {
  _id: Types.ObjectId;
  tokenHash: string;
  userId: Types.ObjectId;
  /** Synchroniser token that must accompany every state-changing request. */
  csrfToken: string;
  userAgent?: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

const sessionSchema = new Schema<ISession>({
  tokenHash: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  csrfToken: { type: String, required: true },
  userAgent: { type: String, maxlength: 300 },
  createdAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});

sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ userId: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = model<ISession>("Session", sessionSchema);
