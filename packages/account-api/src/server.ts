import { serve } from "@hono/node-server";
import { createAdmissionLedger } from "./accounts.js";
import { createClerkIdentityVerifier, createClerkUserDirectory } from "./clerk.js";
import { readAccountApiConfig } from "./config.js";
import { createControlPlane } from "./controlPlane.js";
import { migrate } from "./migrate.js";
import { createPgExecutor } from "./pg.js";

const config = readAccountApiConfig();
const db = createPgExecutor(config.databaseUrl);
await migrate(db);
const ledger = createAdmissionLedger(db);
for (const email of config.seedEmails) await ledger.approve({ email });
for (const clerkUserId of config.seedClerkUserIds) await ledger.approve({ clerkUserId });

const { app, channel, tasks } = createControlPlane({
  db,
  verifier: createClerkIdentityVerifier({
    secretKey: config.clerkSecretKey,
    authorizedParties: config.authorizedParties,
    jwtKey: config.clerkJwtKey,
  }),
  directory: createClerkUserDirectory(config.clerkSecretKey),
  // Only trust X-Forwarded-For when explicitly deployed behind a proxy that sets it.
  clientKey: (request) =>
    (config.trustProxy ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() : null) ||
    "direct",
  log: (line) => console.log(line),
});
// A restart leaves no live channels: reconcile queued/running work before accepting traffic.
await tasks.sweep();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`AceVra account API listening on ${info.address}:${info.port}`);
});
// Outbound node connections arrive as WebSocket upgrades on the same listener.
channel.attach(server as import("node:http").Server);

const shutdown = () => {
  channel.close();
  server.close(() => void db.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
