import { type HydratedDocument, model, Schema, type Types } from "mongoose";

export const USER_ROLES = ["participant", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const ACCOUNT_STATUSES = ["active", "suspended", "banned"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** verified = e-mail domain matched the configured college domains; not_required = no restriction configured. */
export const COLLEGE_STATUSES = ["verified", "unverified", "not_required"] as const;
export type CollegeStatus = (typeof COLLEGE_STATUSES)[number];

export interface IUser {
  _id: Types.ObjectId;
  /** Opaque identifier safe to expose on leaderboards. Never the internal id. */
  publicId: string;
  /** Google `sub` claim. Absent only for administrator records provisioned by the bootstrap script. */
  googleSub?: string | null;
  email: string;
  emailNormalized: string;
  emailDomain: string;
  name: string;
  picture?: string | null;
  hostedDomain?: string | null;
  collegeStatus: CollegeStatus;
  rollNumber?: string | null;
  department?: string | null;
  profileCompletedAt?: Date | null;
  role: UserRole;
  status: AccountStatus;
  /** True for records created by the admin bootstrap script that have never signed in. */
  provisioned: boolean;
  lastLoginAt?: Date | null;
  loginCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    publicId: { type: String, required: true },
    googleSub: { type: String, default: null },
    email: { type: String, required: true, maxlength: 320 },
    emailNormalized: { type: String, required: true, maxlength: 320 },
    emailDomain: { type: String, required: true, maxlength: 255 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    picture: { type: String, default: null, maxlength: 2048 },
    hostedDomain: { type: String, default: null, maxlength: 255 },
    collegeStatus: { type: String, enum: COLLEGE_STATUSES, required: true },
    rollNumber: { type: String, default: null, maxlength: 40 },
    department: { type: String, default: null, maxlength: 100 },
    profileCompletedAt: { type: Date, default: null },
    role: { type: String, enum: USER_ROLES, default: "participant", required: true },
    status: { type: String, enum: ACCOUNT_STATUSES, default: "active", required: true },
    provisioned: { type: Boolean, default: false },
    lastLoginAt: { type: Date, default: null },
    loginCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

userSchema.index({ emailNormalized: 1 }, { unique: true });
userSchema.index({ publicId: 1 }, { unique: true });
// Uniqueness only for real Google identities (provisioned admins have no sub yet).
userSchema.index({ googleSub: 1 }, { unique: true, partialFilterExpression: { googleSub: { $type: "string" } } });
userSchema.index({ role: 1, status: 1 });
userSchema.index({ createdAt: -1 });

export type UserDocument = HydratedDocument<IUser>;
export const User = model<IUser>("User", userSchema);
