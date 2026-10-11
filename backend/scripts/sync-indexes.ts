/** Builds all MongoDB indexes declared on the Mongoose models. */
import { getConfig } from "@/config";
import { connectMongo, disconnectMongo, syncAllIndexes } from "@/database/mongo";
import "@/database/models";

async function main(): Promise<void> {
  await connectMongo(getConfig().mongoUri);
  await syncAllIndexes();
  console.log("MongoDB indexes are in sync.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectMongo());
