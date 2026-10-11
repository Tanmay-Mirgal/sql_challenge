import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "@/app";
import { type AppConfig, buildConfig } from "@/config";
import { parseEnv } from "@/config/env";
import type { Container } from "@/container";
import { connectMongo, disconnectMongo } from "@/database/mongo";
import "@/database/models";
import { createSession } from "@/modules/auth/session.service";
import { User, type UserDocument } from "@/modules/users/user.model";
import { randomPublicId } from "@/utils/crypto";
import { SqlExecutionService } from "@/modules/sql-execution/service";
import { FakeGoogleProvider } from "./fake-google";
import { FakeLlm } from "./fake-llm";

export interface TestContext {
  app: Express;
  container: Container;
  google: FakeGoogleProvider;
  llm: FakeLlm;
  sql: SqlExecutionService;
  config: AppConfig;
}

export async function startTestContext(
  overrides: { config?: (config: AppConfig) => AppConfig; container?: Partial<Container> } = {},
): Promise<TestContext> {
  const uri = process.env.MONGODB_URI as string;
  await connectMongo(uri, `test_${randomUUID().replace(/-/g, "").slice(0, 16)}`);
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const base = buildConfig(parseEnv());
  const config = overrides.config ? overrides.config(base) : base;
  const google = new FakeGoogleProvider();
  const llm = new FakeLlm();
  const sql = SqlExecutionService.create(config.sql);
  const container: Container = { config, google, sql, llm, ...overrides.container };
  return { app: createApp(container), container, google, llm, sql: container.sql, config };
}

export async function stopTestContext(ctx?: TestContext): Promise<void> {
  await ctx?.sql.close();
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await disconnectMongo();
}

export async function createUser(
  overrides: Partial<{ email: string; name: string; role: "participant" | "admin"; status: "active" | "suspended" | "banned"; department: string; rollNumber: string }> = {},
): Promise<UserDocument> {
  const email = (overrides.email ?? `user-${randomUUID().slice(0, 8)}@college.edu`).toLowerCase();
  return User.create({
    publicId: randomPublicId(),
    googleSub: `sub-${randomUUID()}`,
    email,
    emailNormalized: email,
    emailDomain: email.split("@")[1],
    name: overrides.name ?? email.split("@")[0],
    collegeStatus: "not_required",
    role: overrides.role ?? "participant",
    status: overrides.status ?? "active",
    department: overrides.department ?? "Computer Engineering",
    rollNumber: overrides.rollNumber ?? "R" + Math.floor(Math.random() * 1e6),
    profileCompletedAt: new Date(),
    loginCount: 1,
    lastLoginAt: new Date(),
  });
}

/** Authenticated HTTP client: attaches the session cookie and CSRF token automatically. */
export class TestClient {
  constructor(
    private readonly app: Express,
    readonly user: UserDocument,
    private readonly cookie: string,
    readonly csrfToken: string,
  ) {}

  private withAuth(req: request.Test, mutating: boolean): request.Test {
    req.set("Cookie", this.cookie);
    if (mutating) req.set("X-CSRF-Token", this.csrfToken).set("Origin", "http://localhost:3000");
    return req;
  }

  get(path: string) {
    return this.withAuth(request(this.app).get(path), false);
  }
  post(path: string, body?: object) {
    return this.withAuth(request(this.app).post(path).send(body ?? {}), true);
  }
  patch(path: string, body?: object) {
    return this.withAuth(request(this.app).patch(path).send(body ?? {}), true);
  }
  put(path: string, body?: object) {
    return this.withAuth(request(this.app).put(path).send(body ?? {}), true);
  }
  delete(path: string) {
    return this.withAuth(request(this.app).delete(path), true);
  }
  get sessionCookie(): string {
    return this.cookie;
  }
}

export async function clientFor(ctx: TestContext, user: UserDocument): Promise<TestClient> {
  const { token, session } = await createSession(ctx.config, user, "vitest");
  return new TestClient(ctx.app, user, `${ctx.config.session.cookieName}=${token}`, session.csrfToken);
}

export async function newClient(
  ctx: TestContext,
  overrides: Parameters<typeof createUser>[0] = {},
): Promise<TestClient> {
  return clientFor(ctx, await createUser(overrides));
}

export function anonymous(ctx: TestContext) {
  return request(ctx.app);
}
