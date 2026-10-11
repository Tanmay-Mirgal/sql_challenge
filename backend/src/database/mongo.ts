import mongoose from "mongoose";
import { logger } from "@/utils/logger";

mongoose.set("strictQuery", true);
// NOTE: request bodies are always parsed through strict Zod schemas before they reach a
// query, so user-controlled objects (and operator keys) never end up in query filters.

export async function connectMongo(uri: string, dbName?: string): Promise<typeof mongoose> {
  mongoose.connection.on("disconnected", () => logger.warn("MongoDB disconnected"));
  mongoose.connection.on("reconnected", () => logger.info("MongoDB reconnected"));
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
    ...(dbName ? { dbName } : {}),
  });
  logger.info("MongoDB connected");
  return mongoose;
}

export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

export function mongoIsHealthy(): boolean {
  return mongoose.connection.readyState === 1;
}

/** Build every declared index. Safe to call repeatedly. */
export async function syncAllIndexes(): Promise<void> {
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
}
