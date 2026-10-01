import { app } from "electron";
import { createClerkBridge } from "@clerk/electron";
import { ACCOUNT_RENDERER_HOST, ACCOUNT_RENDERER_SCHEME } from "@zcode/shared";
import { ACCOUNT_SCHEME } from "./accountScheme.js";

/**
 * Official Clerk Electron bridge (main side). Alpha storage is memory-only: tokens
 * never reach disk, so an unsigned build cannot leak them through a keychain/plaintext
 * fallback, and users simply sign in again after relaunch.
 *
 * Must run before app ready and BEFORE registerPrivilegedSchemes (see accountScheme.ts).
 */
export function createAccountClerkBridge(): { cleanup(): void } {
  const memory = new Map<string, string>();
  return createClerkBridge({
    storage: {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => void memory.set(key, value),
      removeItem: (key) => void memory.delete(key),
    },
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
