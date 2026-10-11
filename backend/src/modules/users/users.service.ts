import type { AppConfig } from "@/config";
import type { GoogleIdentity } from "@/modules/auth/google.provider";
import { now } from "@/utils/clock";
import { randomPublicId } from "@/utils/crypto";
import { emailDomain, normalizeEmail } from "@/utils/sanitize";
import { type CollegeStatus, User, type UserDocument } from "./user.model";

export type LoginFailureCode =
  | "email_unverified"
  | "domain_not_allowed"
  | "account_disabled"
  | "account_conflict";

export class LoginRejectedError extends Error {
  constructor(readonly code: LoginFailureCode) {
    super(code);
    this.name = "LoginRejectedError";
  }
}

export interface EmailPolicyResult {
  allowed: boolean;
  collegeStatus: CollegeStatus;
  failure?: LoginFailureCode;
}

/**
 * Server-side e-mail policy. The e-mail address and its verification flag come
 * from Google's signed ID token — never from the browser. When college domains
 * are configured, both the address domain and (when present) the Workspace `hd`
 * claim must match.
 */
export function evaluateEmailPolicy(
  identity: Pick<GoogleIdentity, "email" | "emailVerified" | "hostedDomain">,
  allowedDomains: string[],
): EmailPolicyResult {
  if (!identity.emailVerified) return { allowed: false, collegeStatus: "unverified", failure: "email_unverified" };
  if (allowedDomains.length === 0) return { allowed: true, collegeStatus: "not_required" };
  const domain = emailDomain(identity.email);
  const hd = identity.hostedDomain?.toLowerCase();
  const matches = allowedDomains.includes(domain) && (!hd || allowedDomains.includes(hd));
  return matches
    ? { allowed: true, collegeStatus: "verified" }
    : { allowed: false, collegeStatus: "unverified", failure: "domain_not_allowed" };
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

/**
 * Find-or-create the user for a verified Google identity.
 *
 *  1. Match by Google `sub` (the stable identifier).
 *  2. Otherwise match a bootstrap-provisioned administrator record by verified e-mail.
 *  3. Otherwise create a new participant, subject to the e-mail policy.
 *
 * An existing, already-linked account with the same e-mail but a different `sub`
 * is never silently taken over.
 */
export async function upsertFromGoogle(
  config: AppConfig,
  identity: GoogleIdentity,
): Promise<{ user: UserDocument; isNew: boolean }> {
  const emailNormalized = normalizeEmail(identity.email);
  const policy = evaluateEmailPolicy(identity, config.identity.allowedEmailDomains);
  if (!identity.emailVerified) throw new LoginRejectedError("email_unverified");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const loginTime = now();
    let user = await User.findOne({ googleSub: identity.sub });

    if (!user) {
      const byEmail = await User.findOne({ emailNormalized });
      if (byEmail) {
        if (byEmail.googleSub && byEmail.googleSub !== identity.sub) throw new LoginRejectedError("account_conflict");
        // Provisioned administrator (or legacy record) signing in for the first time: link it.
        byEmail.googleSub = identity.sub;
        byEmail.provisioned = false;
        user = byEmail;
      }
    }

    if (user) {
      if (user.status !== "active") throw new LoginRejectedError("account_disabled");
      // Administrators are authorised explicitly (bootstrap script) and bypass the college-domain gate.
      if (user.role !== "admin" && !policy.allowed) throw new LoginRejectedError(policy.failure ?? "domain_not_allowed");
      user.email = identity.email;
      user.emailNormalized = emailNormalized;
      user.emailDomain = emailDomain(identity.email);
      user.name = identity.name.slice(0, 200);
      user.picture = identity.picture ?? null;
      user.hostedDomain = identity.hostedDomain ?? null;
      user.collegeStatus = policy.collegeStatus;
      user.lastLoginAt = loginTime;
      user.loginCount += 1;
      try {
        await user.save();
        return { user, isNew: false };
      } catch (error) {
        if (isDuplicateKey(error) && attempt === 0) continue;
        throw error;
      }
    }

    if (!policy.allowed) throw new LoginRejectedError(policy.failure ?? "domain_not_allowed");

    try {
      const created = await User.create({
        publicId: randomPublicId(),
        googleSub: identity.sub,
        email: identity.email,
        emailNormalized,
        emailDomain: emailDomain(identity.email),
        name: identity.name.slice(0, 200),
        picture: identity.picture ?? null,
        hostedDomain: identity.hostedDomain ?? null,
        collegeStatus: policy.collegeStatus,
        role: "participant",
        status: "active",
        provisioned: false,
        lastLoginAt: loginTime,
        loginCount: 1,
      });
      return { user: created, isNew: true };
    } catch (error) {
      // Two simultaneous first logins: the unique index protects us; retry as a lookup.
      if (isDuplicateKey(error) && attempt === 0) continue;
      throw error;
    }
  }
  throw new Error("Unable to upsert user");
}

export function toSelfDto(user: UserDocument) {
  return {
    id: user.id as string,
    publicId: user.publicId,
    name: user.name,
    email: user.email,
    picture: user.picture ?? null,
    collegeStatus: user.collegeStatus,
    rollNumber: user.rollNumber ?? null,
    department: user.department ?? null,
    profileCompletedAt: user.profileCompletedAt ?? null,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

export type SelfDto = ReturnType<typeof toSelfDto>;

export async function updateProfile(
  user: UserDocument,
  input: { rollNumber?: string | null; department?: string | null },
): Promise<UserDocument> {
  if (input.rollNumber !== undefined) user.rollNumber = input.rollNumber;
  if (input.department !== undefined) user.department = input.department;
  user.profileCompletedAt = user.rollNumber && user.department ? (user.profileCompletedAt ?? now()) : null;
  await user.save();
  return user;
}
