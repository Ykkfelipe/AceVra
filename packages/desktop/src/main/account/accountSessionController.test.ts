import assert from "node:assert/strict";
import test from "node:test";
import type { AccountView } from "@zcode/shared";
import {
  createAccountSessionController,
  type AccountPreferenceStore,
} from "./accountSessionController.js";
import { createAccountTestTokenSource, resolveTestTokenSource } from "./accountTestTokenSource.js";
import { resolveAccountConfig } from "./accountConfig.js";

const ME = {
  account: { id: "acc_1", displayName: "Ada", avatarUrl: null },
  admission: { status: "approved" },
};
const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function memoryPreference(initial: "undecided" | "local" = "undecided") {
  const state = { value: initial, writes: 0 };
  const store: AccountPreferenceStore = {
    read: async () => state.value,
    write: async (choice) => {
      state.value = choice;
      state.writes += 1;
    },
  };
  return { state, store };
}
function setup(respond: (request: Request) => Promise<Response> | Response, token = "tok") {
  const pref = memoryPreference();
  const calls: Request[] = [];
  const tokenSource = createAccountTestTokenSource(token);
  const controller = createAccountSessionController({
    apiBaseUrl: "http://127.0.0.1:9",
    tokenSource,
    preference: pref.store,
    fetch: (async (input: URL | string, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      return respond(request);
    }) as typeof fetch,
  });
  const phases: string[] = [];
  controller.onViewChanged((view) => phases.push(view.phase));
  const settled = (phase: AccountView["phase"]) =>
    new Promise<AccountView>((resolve) => {
      if (controller.getView().phase === phase) return resolve(controller.getView());
      const off = controller.onViewChanged((view) => {
        if (view.phase === phase) {
          off();
          resolve(view);
        }
      });
    });
  return { controller, calls, phases, settled, pref, tokenSource };
}

test("without configuration the account is local-only and never touches the network", async () => {
  const pref = memoryPreference();
  let fetched = 0;
  const controller = createAccountSessionController({
    apiBaseUrl: null,
    tokenSource: null,
    preference: pref.store,
    fetch: (async () => {
      fetched += 1;
      return json(200);
    }) as typeof fetch,
  });
  await controller.start();
  assert.equal(controller.getView().configured, false);
  await controller.signIn();
  await controller.refresh();
  assert.equal(controller.getView().phase, "signedOut");
  await controller.chooseLocal();
  assert.equal(controller.getView().choice, "local");
  assert.equal(pref.state.value, "local");
  assert.equal(fetched, 0);
});

test("sign-in walks authenticating → authenticated → admissionChecking → ready", async () => {
  const { controller, phases, settled, calls } = setup(() => json(200, ME));
  await controller.start();
  await controller.signIn();
  const view = await settled("ready");
  assert.deepEqual(phases.slice(1), [
    "authenticating",
    "authenticated",
    "admissionChecking",
    "ready",
  ]);
  assert.equal(view.profile?.displayName, "Ada");
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer tok");
  assert.equal(new URL(calls[0]!.url).pathname, "/v1/me");
  assert.ok(!JSON.stringify(view).includes("tok"), "the projection never carries the token");
});

test("a Clerk-authenticated but non-admitted user is denied, not ready", async () => {
  const { controller, settled } = setup(() => json(403, { error: "not_admitted" }));
  await controller.start();
  await controller.signIn();
  const view = await settled("denied");
  assert.equal(view.detail, "not_admitted");
  assert.equal(view.profile, undefined);
});

test("a backend 401 returns to signed out and keeps local mode", async () => {
  const { controller, settled } = setup(() => json(401));
  await controller.start();
  await controller.signIn();
  const view = await settled("signedOut");
  assert.equal(view.detail, "session_rejected");
});

for (const [label, respond] of [
  ["unreachable backend", () => Promise.reject(new TypeError("fetch failed"))],
  ["5xx", () => json(503)],
  ["malformed 200", () => json(200, { admission: { status: "approved" } })],
  ["non-JSON 200", () => new Response("<html>", { status: 200 })],
] as const) {
  test(`${label} is offline, never a fabricated ready state`, async () => {
    const { controller, settled } = setup(respond);
    await controller.start();
    await controller.signIn();
    const view = await settled("offline");
    assert.notEqual(view.phase, "ready");
    assert.equal(view.profile, undefined);
  });
}

test("explicit refresh recovers from offline and keeps a stale profile only as a hint", async () => {
  let online = true;
  const { controller, settled } = setup(() =>
    online ? json(200, ME) : Promise.reject(new TypeError("down")),
  );
  await controller.start();
  await controller.signIn();
  await settled("ready");
  online = false;
  await controller.refresh();
  const offline = controller.getView();
  assert.equal(offline.phase, "offline");
  assert.equal(offline.profile?.displayName, "Ada", "stale hint retained");
  online = true;
  await controller.refresh();
  assert.equal(controller.getView().phase, "ready");
});

test("a late admission response after sign-out cannot resurrect the account", async () => {
  let release!: (response: Response) => void;
  const { controller, settled } = setup(
    () => new Promise<Response>((resolve) => (release = resolve)),
  );
  await controller.start();
  await controller.signIn();
  await settled("admissionChecking");
  await controller.signOut();
  release(json(200, ME));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(controller.getView().phase, "signedOut");
  assert.equal(controller.getView().profile, undefined);
});

test("account switch: A's delayed response is ignored after B signs in", async () => {
  const releases: Array<(response: Response) => void> = [];
  const { controller, settled } = setup(
    () => new Promise<Response>((resolve) => releases.push(resolve)),
  );
  await controller.start();
  await controller.signIn();
  await settled("admissionChecking");
  await controller.signOut();
  await controller.signIn();
  await new Promise((resolve) => setTimeout(resolve, 10));
  releases[0]!(json(200, { ...ME, account: { id: "A", displayName: "A", avatarUrl: null } }));
  releases[1]!(json(200, { ...ME, account: { id: "B", displayName: "B", avatarUrl: null } }));
  const view = await settled("ready");
  assert.equal(view.profile?.id, "B");
});

test("sign-out clears the projection, ends the session and survives an offline failure", async () => {
  const { controller, settled, tokenSource, pref } = setup(() => json(200, ME));
  await controller.start();
  await controller.chooseLocal();
  await controller.signIn();
  await settled("ready");
  let ended = 0;
  const original = tokenSource.signOut;
  tokenSource.signOut = async () => {
    ended += 1;
    await original();
    throw new Error("network down");
  };
  await controller.signOut();
  assert.equal(ended, 1);
  assert.equal(controller.getView().phase, "signedOut");
  assert.equal(controller.getView().profile, undefined);
  assert.equal(pref.state.value, "local", "logout does not reset the local choice");
});

test("dismissing the sign-in window returns to signed out", async () => {
  const { controller, tokenSource } = setup(() => json(200, ME));
  await controller.start();
  await controller.signIn();
  await tokenSource.signOut(); // window closed without a session
  assert.equal(controller.getView().phase, "signedOut");
});

test("startup tolerates an unreadable preference file", async () => {
  const controller = createAccountSessionController({
    apiBaseUrl: null,
    tokenSource: null,
    preference: {
      read: async () => {
        throw new Error("EACCES");
      },
      write: async () => {},
    },
    fetch,
  });
  await controller.start();
  assert.equal(controller.getView().choice, "undecided");
});

test("config: https required when packaged, loopback http only for unpackaged builds", () => {
  const env = (base: string) => ({
    ACEVRA_CLERK_PUBLISHABLE_KEY: "pk_test_x",
    ACEVRA_API_BASE_URL: base,
  });
  assert.equal(
    resolveAccountConfig(env("https://api.example.test/x"), { isPackaged: true })?.apiBaseUrl,
    "https://api.example.test",
  );
  assert.equal(resolveAccountConfig(env("http://127.0.0.1:8787"), { isPackaged: true }), null);
  assert.equal(
    resolveAccountConfig(env("http://127.0.0.1:8787"), { isPackaged: false })?.apiBaseUrl,
    "http://127.0.0.1:8787",
  );
  assert.equal(resolveAccountConfig(env("http://evil.test"), { isPackaged: false }), null);
  assert.equal(resolveAccountConfig({}, { isPackaged: false }), null);
  assert.equal(
    resolveAccountConfig({ ACEVRA_API_BASE_URL: "https://a.test" }, { isPackaged: true })
      ?.publishableKey,
    null,
  );
});

test("the test token source is refused for packaged builds", () => {
  const env = { ACEVRA_ACCOUNT_TEST_TOKEN: "t" };
  assert.equal(resolveTestTokenSource(env, { isPackaged: true }), null);
  assert.ok(resolveTestTokenSource(env, { isPackaged: false }));
});

test("the view discloses a non-remembered session only when persistence is unavailable", async () => {
  const make = (rememberSession?: boolean) =>
    createAccountSessionController({
      apiBaseUrl: null,
      tokenSource: null,
      preference: memoryPreference().store,
      fetch,
      rememberSession,
    });
  assert.equal(make(false).getView().rememberSession, false);
  assert.equal(make(true).getView().rememberSession, undefined);
  assert.equal(make().getView().rememberSession, undefined);
});

test("a 401 on another endpoint is confirmed by /v1/me before signing anyone out", async () => {
  // rejectSession must not take a device route's word for it: it re-runs the
  // authoritative admission check, which still succeeds for a healthy session.
  const { controller, settled } = setup(() => json(200, ME));
  await controller.start();
  await controller.signIn();
  await settled("ready");
  controller.rejectSession();
  await settled("ready");
  const view = controller.getView();
  assert.equal(view.phase, "ready", "a surviving session is not signed out by a device 401");
  assert.equal(view.profile?.displayName, "Ada");
});

test("a 401 on another endpoint signs the user out once /v1/me confirms it", async () => {
  let healthy = true;
  const { controller, settled } = setup(() => (healthy ? json(200, ME) : json(401)));
  await controller.start();
  await controller.signIn();
  await settled("ready");
  healthy = false;
  controller.rejectSession();
  const view = await settled("signedOut");
  assert.equal(view.detail, "session_rejected");
  assert.equal(view.profile, undefined);
});

test("a stale 401 from a superseded session cannot sign out the account that replaced it", async () => {
  // Account switching is the exact path this guards: A's heartbeat is in flight when
  // the user signs out of A and into B. A's late 401 must not land on B.
  let releaseMe: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    releaseMe = r;
  });
  let firstCall = true;
  const { controller, settled } = setup(async () => {
    if (firstCall) {
      firstCall = false;
      return json(200, ME);
    }
    // B is admitted and ready; A's parked response is still outstanding.
    return json(200, ME);
  });
  await controller.start();
  await controller.signIn();
  await settled("ready");
  // Sign out of A and into B, then let A's late 401 land.
  await controller.signOut();
  await settled("signedOut");
  await controller.signIn();
  await settled("ready");
  releaseMe!();
  await gate;
  controller.rejectSession();
  await settled("ready");
  assert.equal(controller.getView().phase, "ready");
});

test("rejectSession is a no-op for a build with no account configuration", async () => {
  const controller = createAccountSessionController({
    apiBaseUrl: null,
    tokenSource: null,
    preference: memoryPreference().store,
    fetch,
  });
  controller.rejectSession();
  const view = controller.getView();
  assert.equal(view.phase, "signedOut");
  // Local-only builds must never claim a session was rejected.
  assert.equal(view.detail, undefined);
});

test("rejecting an already-rejected session does not republish or refetch", async () => {
  let healthy = false;
  const { controller, settled, calls } = setup(() => (healthy ? json(200, ME) : json(401)));
  await controller.start();
  await controller.signIn();
  await settled("signedOut");
  assert.equal(controller.getView().detail, "session_rejected");
  const requestsSoFar = calls.length;
  let publishes = 0;
  controller.onViewChanged(() => publishes++);
  controller.rejectSession();
  await new Promise((r) => setImmediate(r));
  assert.equal(publishes, 0, "nothing republished");
  assert.equal(calls.length, requestsSoFar, "no redundant request");
});
