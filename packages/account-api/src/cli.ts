import { createAdmissionLedger } from "./accounts.js";
import { migrate } from "./migrate.js";
import { createPgExecutor } from "./pg.js";

const [command, flag, value] = process.argv.slice(2);
const usage = "usage: admission <approve|revoke|unrevoke> <--email|--clerk-user-id> <value>";
if (!["approve", "revoke", "unrevoke"].includes(command ?? "") || !value) {
  console.error(usage);
  process.exit(2);
}
const databaseUrl = process.env.ACEVRA_DATABASE_URL;
if (!databaseUrl) {
  console.error("Missing required configuration: ACEVRA_DATABASE_URL");
  process.exit(2);
}
const target = flag === "--email" ? { email: value } : { clerkUserId: value };
const db = createPgExecutor(databaseUrl);
try {
  await migrate(db);
  await createAdmissionLedger(db)[command as "approve" | "revoke" | "unrevoke"](target);
  console.log(`${command}: ok`);
} finally {
  await db.close();
}
