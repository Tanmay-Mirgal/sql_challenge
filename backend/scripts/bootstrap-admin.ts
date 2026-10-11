/**
 * Grants the administrator role to the e-mail addresses in ADMIN_EMAILS (or
 * passed as arguments). Run from a trusted shell only:
 *
 *   npm run admin:bootstrap
 *   npm run admin:bootstrap -- teacher@college.edu other@college.edu
 *
 * If the person has not signed in yet, a pending administrator record is
 * created; it is linked to their Google identity at first sign-in, which Google
 * itself has verified.
 */
import { getConfig } from "@/config";
import { ConfigError } from "@/config/env";
import { connectMongo, disconnectMongo, syncAllIndexes } from "@/database/mongo";
import { bootstrapAdmins } from "@/modules/admin/bootstrap-admin";

async function main(): Promise<void> {
  const config = getConfig();
  const emails = process.argv.slice(2).length > 0 ? process.argv.slice(2) : config.identity.adminEmails;
  if (emails.length === 0) {
    console.error("No administrator e-mail given. Set ADMIN_EMAILS in backend/.env or pass addresses as arguments.");
    process.exitCode = 1;
    return;
  }
  await connectMongo(config.mongoUri);
  await syncAllIndexes();
  const results = await bootstrapAdmins(emails);
  for (const result of results) console.log(`${result.action.padEnd(17)} ${result.email}`);
  if (results.some((r) => r.action === "provisioned")) {
    console.log("\nPending administrators will be activated the first time they sign in with Google.");
  }
}

main()
  .catch((error: unknown) => {
    if (error instanceof ConfigError) console.error(error.message);
    else console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectMongo());
