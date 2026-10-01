import { app, safeStorage } from "electron";
import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import { ACCOUNT_RENDERER_HOST, ACCOUNT_RENDERER_SCHEME } from "@zcode/shared";
import { ACCOUNT_SCHEME } from "./accountScheme.js";
import {
  ACCOUNT_TOKEN_STORE_NAME,
  setAccountSessionPersistent,
} from "./accountSessionPersistence.js";
import { selectAccountTokenStorage } from "./accountTokenStorage.js";

/**
 * Official Clerk Electron bridge (main side). Persistence uses Clerk's supported
 * `storage()` adapter: tokens are encrypted with Electron safeStorage (OS keystore). When
 * OS encryption is unavailable it does NOT persist (memory only, sign in again), and the
 * unencrypted fallback is deliberately left off — no plaintext JWT on disk.
 *
 * Must run before app ready and BEFORE registerPrivilegedSchemes (see accountScheme.ts).
 */
export function createAccountClerkBridge(): { cleanup(): void } {
  // Decide BEFORE any Clerk persistence runs: an unavailable keystore must never be touched.
  const selected = selectAccountTokenStorage({
    probe: safeStorage,
    createSecure: () => storage({ name: ACCOUNT_TOKEN_STORE_NAME }),
    diagnostic: (message) => console.warn(`[account] ${message}`),
  });
  setAccountSessionPersistent(selected.persistent);
  return createClerkBridge({
    storage: selected.storage,
    renderer: {
      scheme: ACCOUNT_RENDERER_SCHEME,
      host: ACCOUNT_RENDERER_HOST,
      privileges: ACCOUNT_SCHEME.privileges,
    },
    // The app already owns the single-instance lock and routes second-instance itself.
    manageSingleInstanceLock: false,
    userAgent: `AceVra/${app.getVersion()}`,
  });
}
