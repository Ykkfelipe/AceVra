/**
 * The device client and the session controller, wired the way `accountMain` wires them.
 *
 * This shape matters and is not covered by testing either side alone. The device client
 * reports a 401 through `onUnauthorized` from inside `call()`, which runs *before* each
 * caller's own `attempt !== generation` guard — so a response belonging to a superseded
 * attempt reaches the controller before that guard can discard it. The first M2
 * implementation therefore signed out whoever was signed in *now* when an older
 * session's late heartbeat answered, which is exactly the account-switching path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createAccountDevices } from "./accountDevices.js";
import { createAccountSessionController } from "./accountSessionController.js";
import { createAccountTestTokenSource } from "./accountTestTokenSource.js";

const DEVICE = {
  id: "dev_1",
  displayName: "Mac",
  presence: "online" as const,
  capabilities: [] as never[],
};
const me = (id: string, displayName: string) => ({
  account: { id, displayName, avatarUrl: null },
  admission: { status: "approved" as const },
});
const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Harness {
  controller: ReturnType<typeof createAccountSessionController>;
  signInAs(who: "A" | "B"): Promise<void>;
  landStaleHeartbeat(): Promise<void>;
  registers(): number;
}

function harness(): Harness {
  // Whoever is signed in now. `/v1/me` always answers for them.
  let current: "A" | "B" = "A";
  let registers = 0;
  let parked = false;
  let releaseStale: (() => void) | undefined;
  const staleHeartbeat = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });

  const tokenSource = createAccountTestTokenSource("tok");
  const controller = createAccountSessionController({
    apiBaseUrl: "http://127.0.0.1:9",
    tokenSource,
    preference: { read: async () => "undecided", write: async () => undefined },
    fetch: async () => json(200, current === "A" ? me("acc_A", "Ada") : me("acc_B", "Bea")),
  });

  const devices = createAccountDevices({
    apiBaseUrl: "http://127.0.0.1:9",
    getToken: () => tokenSource.getToken(),
    installationId: async () => "11111111-1111-4111-8111-111111111111",
    describe: () => ({ platform: "darwin", displayName: "Mac", capabilities: [] }),
    onUnauthorized: () => controller.rejectSession(),
    fetch: (async (url: URL) => {
      if (url.pathname.endsWith("/register")) {
        registers += 1;
        assert.ok(registers < 20, "registration must not run away");
        return json(200, { device: DEVICE });
      }
      // One heartbeat in flight under the previous session's token. It answers 401
      // because that token is dead, while `/v1/me` meanwhile presents a fresh one.
      if (url.pathname.endsWith("/heartbeat") && current === "B" && !parked) {
        parked = true;
        await staleHeartbeat;
        return json(401, { error: "unauthenticated" });
      }
      return json(200, { device: DEVICE });
    }) as typeof fetch,
    timers: {
      setInterval: ((fn: () => void) => {
        queueMicrotask(() => {
          void fn();
        });
        return { unref() {} };
      }) as never,
      clearInterval: (() => undefined) as never,
    },
  });

  // Same edge wiring as initAccountMain.
  let wasReady = false;
  controller.onViewChanged((view) => {
    const ready = view.phase === "ready";
    if (ready && !wasReady) void devices.start().catch(() => undefined);
    if (!ready && wasReady) devices.stop();
    wasReady = ready;
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  return {
    controller,
    async signInAs(who) {
      current = who;
      await controller.signIn();
      await settle();
    },
    async landStaleHeartbeat() {
      releaseStale?.();
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
    registers: () => registers,
  };
}

test("a stale 401 from the previous session cannot sign out the account that replaced it", async () => {
  const h = harness();
  await h.controller.start();
  await h.signInAs("A");
  assert.equal(h.controller.getView().profile?.displayName, "Ada");

  await h.controller.signOut();
  await h.signInAs("B");
  assert.equal(h.controller.getView().profile?.displayName, "Bea");

  await h.landStaleHeartbeat();

  const view = h.controller.getView();
  assert.equal(view.phase, "ready", "B stays signed in");
  assert.equal(view.detail, undefined, "no rejected-session reason is attached");
  assert.equal(view.profile?.displayName, "Bea", "still B's profile, not A's");
});

test("a 401 that /v1/me confirms still signs the user out", async () => {
  // The counterpart: the confirmation step is what makes the safe case safe, so it must
  // not swallow a genuinely dead session.
  const tokenSource = createAccountTestTokenSource("tok");
  let alive = true;
  const controller = createAccountSessionController({
    apiBaseUrl: "http://127.0.0.1:9",
    tokenSource,
    preference: { read: async () => "undecided", write: async () => undefined },
    fetch: async () => (alive ? json(200, me("acc_A", "Ada")) : json(401)),
  });
  const devices = createAccountDevices({
    apiBaseUrl: "http://127.0.0.1:9",
    getToken: () => tokenSource.getToken(),
    installationId: async () => "11111111-1111-4111-8111-111111111111",
    describe: () => ({ platform: "darwin", displayName: "Mac", capabilities: [] }),
    onUnauthorized: () => controller.rejectSession(),
    // The device route reports the rejection; /v1/me then confirms it.
    fetch: (async () => (alive ? json(200, { device: DEVICE }) : json(401))) as typeof fetch,
  });
  await controller.start();
  await controller.signIn();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(controller.getView().phase, "ready");

  alive = false;
  void devices.call("GET", "/v1/devices");
  await new Promise((r) => setTimeout(r, 100));

  const view = controller.getView();
  assert.equal(view.phase, "signedOut");
  assert.equal(view.detail, "session_rejected");
  assert.equal(view.profile, undefined);
});
