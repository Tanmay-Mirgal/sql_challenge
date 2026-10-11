import { z } from "zod";
import { User } from "@/modules/users/user.model";
import { recordAudit } from "./audit.service";
import { randomPublicId } from "@/utils/crypto";
import { emailDomain, normalizeEmail } from "@/utils/sanitize";

export type BootstrapAction =
  | "provisioned" // no account yet: a pending admin record was created, linked at first Google sign-in
  | "promoted" // existing participant account promoted to administrator
  | "already_admin"
  | "skipped_inactive" // account exists but is suspended/banned — refuse to elevate
  | "invalid_email";

export interface BootstrapResult {
  email: string;
  action: BootstrapAction;
}

const emailSchema = z.email();

/**
 * Grants the administrator role to explicitly configured e-mail addresses.
 * Runs only from a trusted operator context (CLI script) — never from an HTTP
 * request — so no public endpoint can create or elevate an administrator.
 */
export async function bootstrapAdmins(emails: string[]): Promise<BootstrapResult[]> {
  const results: BootstrapResult[] = [];
  const unique = [...new Set(emails.map(normalizeEmail).filter(Boolean))];

  for (const email of unique) {
    if (!emailSchema.safeParse(email).success) {
      results.push({ email, action: "invalid_email" });
      continue;
    }
    const existing = await User.findOne({ emailNormalized: email });
    if (!existing) {
      const created = await User.create({
        publicId: randomPublicId(),
        googleSub: null,
        email,
        emailNormalized: email,
        emailDomain: emailDomain(email),
        name: email.split("@")[0] ?? "Administrator",
        collegeStatus: "unverified",
        role: "admin",
        status: "active",
        provisioned: true,
      });
      await recordAudit({ action: "admin.bootstrap.provision", targetType: "user", targetId: created.id, metadata: { email } });
      results.push({ email, action: "provisioned" });
      continue;
    }
    if (existing.status !== "active") {
      results.push({ email, action: "skipped_inactive" });
      continue;
    }
    if (existing.role === "admin") {
      results.push({ email, action: "already_admin" });
      continue;
    }
    existing.role = "admin";
    await existing.save();
    await recordAudit({ action: "admin.bootstrap.promote", targetType: "user", targetId: existing.id, metadata: { email } });
    results.push({ email, action: "promoted" });
  }
  return results;
}
