import assert from "node:assert/strict";
import test from "node:test";
import { createAccountSessions } from "./accountSessions.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SESSION = {
  id: "sess_1",
  status: "active",
  createdAt: 1_699_000_000_000,
  lastActiveAt: 1_700_000_000_000,
  deviceType: "Desktop",
  browserName: "Electron",
  country: "CO",
  current: true,
};

function client(respond: (path: string) => Response | null) {
  const calls: string[] = [];
  const sessions = createAccountSessions(async (method, path) => {
    calls.push(`${method} ${path}`);
    const out = respond(path);
    return out ? { status: out.status, json: (await out.json()) as Record<string, any> } : null;
  });
  return { sessions, calls };
}

test("a good list is parsed, including the backend's current marker", async () => {
  const { sessions, calls } = client(() => json(200, { sessions: [SESSION] }));
  const view = await sessions.list();
  assert.deepEqual(calls, ["GET /v1/sessions"]);
  assert.equal(view.sessions.length, 1);
  assert.equal(view.sessions[0]!.current, true);
  assert.equal(view.unavailable, undefined);
});

test("an unreachable backend is unavailable, not an empty list", async () => {
  // "You have no other sessions" and "we could not check" are different facts. Only
  // the second is worth a retry, and only the first is reassuring.
  const { sessions } = client(() => null);
  const view = await sessions.list();
  assert.deepEqual(view.sessions, []);
  assert.equal(view.unavailable, true);
});

test("a rejected session is not reported as an empty or unavailable list", async () => {
  const { sessions } = client(() => json(401, { error: "unauthenticated" }));
  const view = await sessions.list();
  // The transport already routed this 401 through M2's re-auth path. Reporting it as
  // an ordinary empty list would bury that.
  assert.equal(view.unavailable, true);
});

test("an unparseable body is never presented as a confident list", async () => {
  const { sessions } = client(() => json(200, { sessions: [{ id: "sess_1" }] }));
  const view = await sessions.list();
  assert.equal(view.unavailable, true);
  assert.deepEqual(view.sessions, []);
});

test("revoking maps the outcomes the backend actually returns", async () => {
  const ok = client(() => json(200, { ok: true }));
  assert.deepEqual(await ok.sessions.revoke("sess_1"), { status: "revoked" });
  assert.deepEqual(ok.calls, ["POST /v1/sessions/sess_1/revoke"]);

  const missing = client(() => json(404, { error: "not_found" }));
  assert.deepEqual(await missing.sessions.revoke("sess_1"), { status: "not_found" });

  const limited = client(() => json(429, { error: "rate_limited" }));
  assert.deepEqual(await limited.sessions.revoke("sess_1"), { status: "unavailable" });

  const offline = client(() => null);
  assert.deepEqual(await offline.sessions.revoke("sess_1"), { status: "unavailable" });
});

test("a session id is encoded, so it cannot escape the path", async () => {
  const { sessions, calls } = client(() => json(200, { ok: true }));
  await sessions.revoke("../../v1/devices/dev_1/revoke");
  assert.deepEqual(calls, ["POST /v1/sessions/..%2F..%2Fv1%2Fdevices%2Fdev_1%2Frevoke/revoke"]);
});

test("without an account transport every call is safely unavailable", async () => {
  const sessions = createAccountSessions(null);
  assert.deepEqual(await sessions.list(), { sessions: [], unavailable: true });
  assert.deepEqual(await sessions.revoke("sess_1"), { status: "unavailable" });
});
