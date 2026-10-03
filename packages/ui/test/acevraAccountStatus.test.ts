/**
 * AceVra account status presentation.
 *
 * These pin the two rules the account lifecycle depends on:
 *  - a rejected session reads differently from a never-signed-in account, so the user can
 *    tell "you were signed in and something ended it" from "you are simply signed out"; and
 *  - no state ever implies that signing in connected an external service or trusted a
 *    device, because neither is true of account authentication.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AccountView } from "@zcode/shared";
import { describeAccountStatus } from "../src/account/accountStatus.js";

/** Returns the key itself for unknown ids, mirroring useAccountText. */
const text = (id: string, _fallback: string) => id;

const view = (patch: Partial<AccountView> = {}): AccountView => ({
  configured: true,
  choice: "undecided",
  phase: "signedOut",
  ...patch,
});

test("a rejected session is distinguishable from a plain signed-out account", () => {
  const rejected = describeAccountStatus(view({ detail: "session_rejected" }), text);
  const plain = describeAccountStatus(view(), text);
  assert.notEqual(rejected, plain);
  assert.equal(plain, "status.signedOut");
  assert.equal(rejected, "status.rejected");
});

test("every phase maps to a status key, with the two checking phases deliberately shared", () => {
  const byKey = new Map<string, AccountView["phase"][]>();
  for (const phase of [
    "signedOut",
    "authenticating",
    "authenticated",
    "admissionChecking",
    "ready",
    "denied",
    "offline",
  ] as const) {
    const key = describeAccountStatus(view({ phase }), text);
    byKey.set(key, [...(byKey.get(key) ?? []), phase]);
  }
  // `authenticated` and `admissionChecking` both mean "we are checking your access",
  // so collapsing them is intentional. Every other phase must be distinguishable, or
  // the user cannot tell a terminal state from a transient one.
  const shared = [...byKey.values()].filter((phases) => phases.length > 1);
  assert.deepEqual(shared, [["authenticated", "admissionChecking"]]);
  assert.equal(byKey.size, 6);
});

test("a denied account is told local use still works", () => {
  assert.equal(
    describeAccountStatus(view({ phase: "denied", detail: "not_admitted" }), text),
    "status.denied",
  );
  assert.equal(
    describeAccountStatus(view({ phase: "offline", detail: "unreachable" }), text),
    "status.offline",
  );
});

test("an offline account keeps its stale profile only as a hint and never claims ready", () => {
  const stale = describeAccountStatus(
    view({ phase: "offline", profile: { id: "a1", displayName: "Ada", avatarUrl: null } }),
    text,
  );
  assert.equal(stale, "status.offline");
  assert.notEqual(stale, "status.ready");
});

test("no status implies that signing in connected a service or trusted a device", () => {
  // The copy must stay about the account itself. Claiming a sync, a connection or a
  // trusted machine here would contradict the server: admission covers the account, and
  // devices are registered separately after sign-in.
  const forbidden =
    /\b(sync|syncing|connected|connect your|gmail|calendar|repositor|trusted|paired|device)/i;
  for (const phase of [
    "signedOut",
    "authenticating",
    "authenticated",
    "admissionChecking",
    "ready",
    "denied",
    "offline",
  ] as const) {
    for (const detail of [
      undefined,
      "not_admitted",
      "unreachable",
      "session_rejected",
      "failed",
    ] as const) {
      const message = describeAccountStatus(view({ phase, detail }), text);
      assert.doesNotMatch(message, forbidden, `phase ${phase}/${detail}: ${message}`);
    }
  }
});
