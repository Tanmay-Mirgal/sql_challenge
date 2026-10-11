import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { bootstrapAdmins } from "@/modules/admin/bootstrap-admin";
import { sanitizeReturnTo } from "@/modules/auth/auth.service";
import { UnconfiguredGoogleProvider } from "@/modules/auth/google.provider";
import { Session } from "@/modules/auth/session.model";
import { evaluateEmailPolicy, upsertFromGoogle } from "@/modules/users/users.service";
import { User } from "@/modules/users/user.model";
import { setClock } from "@/utils/clock";
import {
  anonymous,
  clientFor,
  createUser,
  newClient,
  startTestContext,
  stopTestContext,
  type TestContext,
} from "./helpers/test-app";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestContext();
});
afterAll(async () => {
  setClock(undefined);
  await stopTestContext();
});

function cookiesOf(res: request.Response): string[] {
  const header = res.headers["set-cookie"] as unknown;
  return Array.isArray(header) ? (header as string[]) : header ? [String(header)] : [];
}
function cookieValue(res: request.Response, name: string): string | undefined {
  const entry = cookiesOf(res).find((c) => c.startsWith(`${name}=`));
  return entry?.split(";")[0]?.slice(name.length + 1);
}

/** Drives the whole browser flow: /auth/google -> Google -> callback. */
async function signIn(code: string, identity: { sub: string; email: string; hostedDomain?: string; emailVerified?: boolean }) {
  ctx.google.register(code, identity);
  const start = await anonymous(ctx).get("/api/v1/auth/google?returnTo=/challenge/abc");
  expect(start.status).toBe(302);
  const authUrl = new URL(start.headers.location as string);
  const state = authUrl.searchParams.get("state") as string;
  const txCookie = cookiesOf(start).find((c) => c.startsWith("sql_challenge_session_oauth="))!;
  const callback = await anonymous(ctx)
    .get(`/api/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`)
    .set("Cookie", txCookie.split(";")[0] as string);
  return { start, callback, state, txCookie };
}

describe("Google OAuth flow", () => {
  it("reports configuration to the login page without leaking secrets", async () => {
    const res = await anonymous(ctx).get("/api/v1/auth/config");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ googleConfigured: true, missingConfig: [], collegeEmailDomains: [] });
    expect(JSON.stringify(res.body)).not.toContain("test-client-secret");
  });

  it("registers a new student, sets an HttpOnly session cookie and redirects to the allowlisted path", async () => {
    const { start, callback } = await signIn("code-new", { sub: "g-1", email: "Alice@College.edu" });
    expect(start.headers["set-cookie"]?.toString()).toMatch(/HttpOnly/i);
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe("http://localhost:3000/auth/callback?next=%2Fchallenge%2Fabc");
    const session = cookiesOf(callback).find((c) => c.startsWith("sql_challenge_session="))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).not.toMatch(/Secure/i); // COOKIE_SECURE=false in the test environment

    const me = await anonymous(ctx).get("/api/v1/auth/me").set("Cookie", session.split(";")[0] as string);
    expect(me.status).toBe(200);
    expect(me.body.data.user).toMatchObject({ email: "Alice@College.edu", role: "participant", status: "active" });
    expect(me.body.data.csrfToken).toBeTypeOf("string");
    expect(me.body.data.user).not.toHaveProperty("googleSub");
    expect(await User.countDocuments({ emailNormalized: "alice@college.edu" })).toBe(1);
  });

  it("logs the same student in again without creating a duplicate account", async () => {
    await signIn("code-bob-1", { sub: "g-bob", email: "bob@college.edu" });
    await signIn("code-bob-2", { sub: "g-bob", email: "bob@college.edu" });
    const users = await User.find({ googleSub: "g-bob" });
    expect(users).toHaveLength(1);
    expect(users[0]?.loginCount).toBe(2);
  });

  it("prevents duplicate accounts under concurrent first logins", async () => {
    const identity = { sub: "g-race", email: "race@college.edu", emailVerified: true, name: "Race" };
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => upsertFromGoogle(ctx.config, identity)));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await User.countDocuments({ googleSub: "g-race" })).toBe(1);
  });

  it("refuses to take over an existing account that is linked to a different Google identity", async () => {
    await createUser({ email: "linked@college.edu" });
    const { callback } = await signIn("code-conflict", { sub: "g-different", email: "linked@college.edu" });
    expect(callback.headers.location).toBe("http://localhost:3000/auth/callback?error=account_conflict");
    expect(cookieValue(callback, "sql_challenge_session")).toBeUndefined();
  });

  it("rejects a mismatched state parameter", async () => {
    ctx.google.register("code-state", { sub: "g-state", email: "state@college.edu" });
    const start = await anonymous(ctx).get("/api/v1/auth/google");
    const tx = cookiesOf(start).find((c) => c.startsWith("sql_challenge_session_oauth="))!.split(";")[0] as string;
    const res = await anonymous(ctx).get("/api/v1/auth/google/callback?code=code-state&state=forged").set("Cookie", tx);
    expect(res.headers.location).toBe("http://localhost:3000/auth/callback?error=invalid_state");
    expect(cookieValue(res, "sql_challenge_session")).toBeUndefined();
    expect(await User.countDocuments({ googleSub: "g-state" })).toBe(0);
  });

  it("rejects a callback without the browser-bound transaction cookie (login CSRF)", async () => {
    ctx.google.register("code-nocookie", { sub: "g-nc", email: "nc@college.edu" });
    const start = await anonymous(ctx).get("/api/v1/auth/google");
    const state = new URL(start.headers.location as string).searchParams.get("state") as string;
    const res = await anonymous(ctx).get(`/api/v1/auth/google/callback?code=code-nocookie&state=${state}`);
    expect(res.headers.location).toContain("error=invalid_state");
  });

  it("rejects a tampered transaction cookie", async () => {
    const start = await anonymous(ctx).get("/api/v1/auth/google");
    const state = new URL(start.headers.location as string).searchParams.get("state") as string;
    const res = await anonymous(ctx)
      .get(`/api/v1/auth/google/callback?code=x&state=${state}`)
      .set("Cookie", "sql_challenge_session_oauth=eyJzIjoiYSJ9.AAAA");
    expect(res.headers.location).toContain("error=invalid_state");
  });

  it("rejects an ID token whose nonce does not match", async () => {
    ctx.google.nonceOverride = "attacker-nonce";
    try {
      const { callback } = await signIn("code-nonce", { sub: "g-nonce", email: "nonce@college.edu" });
      expect(callback.headers.location).toContain("error=invalid_state");
      expect(await User.countDocuments({ googleSub: "g-nonce" })).toBe(0);
    } finally {
      ctx.google.nonceOverride = undefined;
    }
  });

  it("handles user denial and failed code exchange safely", async () => {
    const start = await anonymous(ctx).get("/api/v1/auth/google");
    const state = new URL(start.headers.location as string).searchParams.get("state") as string;
    const tx = cookiesOf(start).find((c) => c.startsWith("sql_challenge_session_oauth="))!.split(";")[0] as string;
    const denied = await anonymous(ctx).get(`/api/v1/auth/google/callback?error=access_denied&state=${state}`).set("Cookie", tx);
    expect(denied.headers.location).toContain("error=oauth_denied");

    const start2 = await anonymous(ctx).get("/api/v1/auth/google");
    const state2 = new URL(start2.headers.location as string).searchParams.get("state") as string;
    const tx2 = cookiesOf(start2).find((c) => c.startsWith("sql_challenge_session_oauth="))!.split(";")[0] as string;
    const bad = await anonymous(ctx).get(`/api/v1/auth/google/callback?code=unknown-code&state=${state2}`).set("Cookie", tx2);
    expect(bad.headers.location).toContain("error=exchange_failed");
  });

  it("rejects unverified e-mail addresses", async () => {
    const { callback } = await signIn("code-unv", { sub: "g-unv", email: "unv@college.edu", emailVerified: false });
    expect(callback.headers.location).toContain("error=email_unverified");
    expect(await User.countDocuments({ googleSub: "g-unv" })).toBe(0);
  });

  it("refuses sign-in for suspended accounts", async () => {
    await User.create({
      publicId: "pub-susp", googleSub: "g-susp", email: "susp@college.edu", emailNormalized: "susp@college.edu",
      emailDomain: "college.edu", name: "S", collegeStatus: "not_required", status: "suspended",
    });
    const { callback } = await signIn("code-susp", { sub: "g-susp", email: "susp@college.edu" });
    expect(callback.headers.location).toContain("error=account_disabled");
  });
});

describe("college e-mail policy (server-enforced)", () => {
  it("accepts any verified account when no domains are configured", () => {
    expect(evaluateEmailPolicy({ email: "a@gmail.com", emailVerified: true }, [])).toEqual({ allowed: true, collegeStatus: "not_required" });
  });
  it("requires a matching domain (and matching hd claim) when configured", () => {
    const domains = ["college.edu"];
    expect(evaluateEmailPolicy({ email: "a@college.edu", emailVerified: true }, domains).collegeStatus).toBe("verified");
    expect(evaluateEmailPolicy({ email: "a@gmail.com", emailVerified: true }, domains).failure).toBe("domain_not_allowed");
    expect(evaluateEmailPolicy({ email: "a@college.edu", emailVerified: true, hostedDomain: "other.org" }, domains).failure).toBe("domain_not_allowed");
    expect(evaluateEmailPolicy({ email: "a@college.edu", emailVerified: false }, domains).failure).toBe("email_unverified");
    // look-alike domains must not match by suffix
    expect(evaluateEmailPolicy({ email: "a@evilcollege.edu", emailVerified: true }, domains).allowed).toBe(false);
    expect(evaluateEmailPolicy({ email: "a@college.edu.evil.com", emailVerified: true }, domains).allowed).toBe(false);
  });

  it("blocks non-college accounts end to end but lets provisioned administrators in", async () => {
    const restricted = { ...ctx.config, identity: { ...ctx.config.identity, allowedEmailDomains: ["college.edu"] } };
    const gmail = await upsertFromGoogle(restricted, { sub: "g-gm", email: "x@gmail.com", emailVerified: true, name: "X" }).catch((e: Error) => e);
    expect((gmail as Error).message).toBe("domain_not_allowed");

    await bootstrapAdmins(["boss@gmail.com"]);
    const admin = await upsertFromGoogle(restricted, { sub: "g-boss", email: "boss@gmail.com", emailVerified: true, name: "Boss" });
    expect(admin.user.role).toBe("admin");
    expect(admin.user.provisioned).toBe(false);
  });
});

describe("sessions, logout and CSRF", () => {
  it("keeps the session across requests and invalidates it server-side on logout", async () => {
    const client = await newClient(ctx);
    for (let i = 0; i < 3; i += 1) expect((await client.get("/api/v1/auth/me")).status).toBe(200);

    const noCsrf = await request(ctx.app).post("/api/v1/auth/logout").set("Cookie", client.sessionCookie);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe("CSRF_INVALID");

    const out = await client.post("/api/v1/auth/logout");
    expect(out.status).toBe(204);
    expect(cookiesOf(out).join(";")).toMatch(/sql_challenge_session=;/);

    // The old cookie is dead even if an attacker kept a copy.
    const after = await request(ctx.app).get("/api/v1/auth/me").set("Cookie", client.sessionCookie);
    expect(after.status).toBe(401);
    expect(await Session.countDocuments({ userId: client.user._id })).toBe(0);
  });

  it("expires sessions using the server clock", async () => {
    const client = await newClient(ctx);
    expect((await client.get("/api/v1/auth/me")).status).toBe(200);
    setClock(() => new Date(Date.now() + 100 * 24 * 3_600_000));
    try {
      expect((await client.get("/api/v1/auth/me")).status).toBe(401);
    } finally {
      setClock(undefined);
    }
  });

  it("drops sessions of users who are suspended after signing in", async () => {
    const client = await newClient(ctx);
    await User.updateOne({ _id: client.user._id }, { status: "suspended" });
    expect((await client.get("/api/v1/auth/me")).status).toBe(401);
  });

  it("rejects state-changing requests from foreign origins", async () => {
    const client = await newClient(ctx);
    const res = await request(ctx.app)
      .patch("/api/v1/me/profile")
      .set("Cookie", client.sessionCookie)
      .set("X-CSRF-Token", client.csrfToken)
      .set("Origin", "https://evil.example")
      .send({ department: "CSE" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("requires authentication for protected APIs", async () => {
    expect((await anonymous(ctx).get("/api/v1/auth/me")).status).toBe(401);
    expect((await anonymous(ctx).get("/api/v1/me/profile")).status).toBe(401);
    expect((await anonymous(ctx).patch("/api/v1/me/profile").send({})).status).toBe(401);
  });
});

describe("profile and role safety", () => {
  it("updates only whitelisted profile fields", async () => {
    const client = await newClient(ctx);
    const res = await client.patch("/api/v1/me/profile", { rollNumber: "CE-2021-042", department: "Computer Engineering" });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ rollNumber: "CE-2021-042", department: "Computer Engineering" });
    expect(res.body.data.user.profileCompletedAt).not.toBeNull();
  });

  it("cannot be used to grant administrator privileges (mass assignment)", async () => {
    const client = await newClient(ctx);
    for (const body of [{ role: "admin" }, { department: "CSE", role: "admin" }, { status: "active", email: "x@y.z" }]) {
      const res = await client.patch("/api/v1/me/profile", body);
      expect(res.status).toBe(400);
    }
    const fresh = await User.findById(client.user._id);
    expect(fresh?.role).toBe("participant");
    // A client-supplied role header/cookie/body field is never consulted either.
    const spoof = await request(ctx.app).get("/api/v1/auth/me").set("Cookie", client.sessionCookie).set("X-User-Role", "admin");
    expect(spoof.body.data.user.role).toBe("participant");
  });

  it("validates input", async () => {
    const client = await newClient(ctx);
    const res = await client.patch("/api/v1/me/profile", { rollNumber: "<script>", department: "x".repeat(500) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("administrator bootstrap", () => {
  it("promotes existing accounts, provisions pending ones and never elevates disabled accounts", async () => {
    const existing = await createUser({ email: "promote@college.edu" });
    const banned = await createUser({ email: "banned@college.edu", status: "banned" });
    const results = await bootstrapAdmins(["promote@college.edu", "PENDING@college.edu", "banned@college.edu", "not-an-email", "promote@college.edu"]);
    expect(results).toEqual([
      { email: "promote@college.edu", action: "promoted" },
      { email: "pending@college.edu", action: "provisioned" },
      { email: "banned@college.edu", action: "skipped_inactive" },
      { email: "not-an-email", action: "invalid_email" },
    ]);
    expect((await User.findById(existing._id))?.role).toBe("admin");
    expect((await User.findById(banned._id))?.role).toBe("participant");
    expect((await bootstrapAdmins(["promote@college.edu"]))[0]?.action).toBe("already_admin");

    // The pending record is linked on first Google sign-in and keeps the admin role.
    const { callback } = await signIn("code-pending", { sub: "g-pending", email: "pending@college.edu" });
    expect(callback.status).toBe(302);
    const user = await User.findOne({ googleSub: "g-pending" });
    expect(user?.role).toBe("admin");
    expect(await User.countDocuments({ emailNormalized: "pending@college.edu" })).toBe(1);
  });

  it("gives participants no way to reach admin endpoints", async () => {
    const participant = await newClient(ctx);
    const admin = await newClient(ctx, { role: "admin" });
    expect((await participant.get("/api/v1/admin/ping")).status).toBe(403);
    expect((await admin.get("/api/v1/admin/ping")).status).toBe(200);
    expect((await anonymous(ctx).get("/api/v1/admin/ping")).status).toBe(401);
    const upgraded = await clientFor(ctx, (await User.findById(participant.user._id))!);
    expect((await upgraded.get("/api/v1/admin/ping")).status).toBe(403);
  });
});

describe("return-path allowlist", () => {
  it.each([
    ["/dashboard", "/dashboard"],
    ["/challenge/abc?x=1", "/challenge/abc?x=1"],
    ["/admin/events", "/admin/events"],
    ["https://evil.com", "/dashboard"],
    ["//evil.com", "/dashboard"],
    ["/\\evil.com", "/dashboard"],
    ["/dashboard/../../etc", "/dashboard"],
    ["/unknown", "/dashboard"],
    ["javascript:alert(1)", "/dashboard"],
    ["/dashboard\r\nSet-Cookie: x=1", "/dashboard"],
    [undefined, "/dashboard"],
    [["/dashboard"], "/dashboard"],
  ])("sanitizes %j", (input, expected) => {
    expect(sanitizeReturnTo(input)).toBe(expected);
  });
});

describe("when Google OAuth is not configured", () => {
  it("fails loudly with setup guidance instead of pretending to work", async () => {
    const unconfigured = { ...ctx, app: createApp({ ...ctx.container, google: new UnconfiguredGoogleProvider() }) };
    const config = await anonymous(unconfigured).get("/api/v1/auth/config");
    expect(config.body.data.googleConfigured).toBe(false);
    expect(config.body.data.missingConfig).toContain("GOOGLE_CLIENT_ID");
    const start = await anonymous(unconfigured).get("/api/v1/auth/google");
    expect(start.status).toBe(302);
    expect(start.headers.location).toBe("http://localhost:3000/auth/callback?error=auth_not_configured");
  });
});
