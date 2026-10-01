import { serve } from "@hono/node-server";
import { createAccountApp } from "./app.js";
import { createDeviceService } from "./devices.js";
import { createDeviceChannel } from "./deviceChannel.js";
import { createPairingService } from "./pairing.js";
import { createAccountService, createAdmissionLedger } from "./accounts.js";
import { createClerkIdentityVerifier, createClerkUserDirectory } from "./clerk.js";
import { readAccountApiConfig } from "./config.js";
import { migrate } from "./migrate.js";
import { createPgExecutor } from "./pg.js";

const config = readAccountApiConfig();
const db = createPgExecutor(config.databaseUrl);
await migrate(db);
const ledger = createAdmissionLedger(db);
for (const email of config.seedEmails) await ledger.approve({ email });
for (const clerkUserId of config.seedClerkUserIds) await ledger.approve({ clerkUserId });

const channel = createDeviceChannel({ db });
const app = createAccountApp({
  pairings: createPairingService(db),
  onDeviceRevoked: (id) => channel.closeDevice(id, "revoked"),
  verifier: createClerkIdentityVerifier({
    secretKey: config.clerkSecretKey,
    authorizedParties: config.authorizedParties,
    jwtKey: config.clerkJwtKey,
  }),
  devices: createDeviceService(db, Date.now, { isLive: channel.isLive }),
  accounts: createAccountService({
    db,
    directory: createClerkUserDirectory(config.clerkSecretKey),
  }),
});
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`AceVra account API listening on :${info.port}`);
});
