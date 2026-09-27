// CUA-4 services read model: owner-session-filtered session projection with Helper
// reconciliation, and the confined observation frame read. Deterministic fakes only.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLeaseAuthority } from "../src/cua-permission-broker/lease-authority/authority.js";
import {
  describeComputerUseSession,
  observationRoots,
  readComputerUseObservationFrame,
} from "../src/cua-permission-broker/cuaSessionView.js";

function sessionAuthority() {
  return createLeaseAuthority({ now: () => 1_000 });
}

function reportedSession(authority: ReturnType<typeof sessionAuthority>) {
  authority.reportActivity({
    session: "session-a",
    task: "turn-1",
    callId: "call-1",
    phase: "completed",
    method: "observe",
    at: 20,
    effect: "confirmed",
    target: { pid: 101, app: "Notes", window: "Shopping list" },
    observation: {
      id: "00000000-0000-0000-0000-000000000002",
      width: 100,
      height: 50,
      blank: false,
      framePath: "/frames/00000000-0000-0000-0000-000000000002.png",
    },
  });
}

test("session view is present:false without an authority or any session activity", async () => {
  assert.deepEqual(
    await describeComputerUseSession({ authority: undefined, host: undefined }, "s"),
    {
      present: false,
    },
  );
  const authority = sessionAuthority();
  assert.deepEqual(await describeComputerUseSession({ authority, host: undefined }, "s"), {
    present: false,
  });
});

test("session view exposes activity and observation for the owning session and never the frame path", async () => {
  const authority = sessionAuthority();
  reportedSession(authority);
  const view = await describeComputerUseSession({ authority, host: undefined }, "session-a");
  assert.equal(view.present, true);
  if (!view.present) return;
  assert.equal(view.sessionId, "session-a");
  assert.equal(view.activity?.method, "observe");
  assert.equal(view.activity?.effect, "confirmed");
  assert.deepEqual(view.observation?.target, { pid: 101, app: "Notes", window: "Shopping list" });
  assert.equal(view.observation?.width, 100);
  assert.equal(JSON.stringify(view).includes("framePath"), false);
  assert.equal(JSON.stringify(view).includes("/frames/"), false);
  assert.equal(view.stopMeaningful, false);
});

test("another session never sees this session's activity, observation, or lease", async () => {
  const authority = sessionAuthority();
  reportedSession(authority);
  const reservation = await authority.beginAcquire({ session: "session-a", task: "turn-1" });
  await authority.commitAcquire(reservation.leaseId, "helper-lease-1", "requirement");
  const other = await describeComputerUseSession({ authority, host: undefined }, "session-b");
  // Another session has nothing on record and does not own the lease: nothing to show at all.
  assert.deepEqual(other, { present: false });
});

test("an active Helper-reported termination reconciles into the authority as the yield reason", async () => {
  const authority = sessionAuthority();
  const reservation = await authority.beginAcquire({ session: "session-a", task: "turn-1" });
  await authority.commitAcquire(reservation.leaseId, "helper-lease-1", "requirement");
  const queries: string[] = [];
  const view = await describeComputerUseSession(
    {
      authority,
      host: {
        async queryControlStatus(params) {
          queries.push(params.lease_id);
          return { lease_state: "interrupted", effect: "confirmed" };
        },
      },
    },
    "session-a",
  );
  assert.deepEqual(queries, ["helper-lease-1"]);
  assert.equal(view.present, true);
  if (!view.present) return;
  assert.equal(view.lease.state, "released");
  assert.equal(view.lease.termination?.reason, "interrupted");
  assert.equal(authority.getAdmission().paused, false);
});

test("a non-terminal Helper state never releases, and a failing query is only presentation", async () => {
  for (const helperState of ["active", "unknown"]) {
    const authority = sessionAuthority();
    const reservation = await authority.beginAcquire({ session: "session-a", task: "turn-1" });
    await authority.commitAcquire(reservation.leaseId, "helper-lease-1", "requirement");
    const view = await describeComputerUseSession(
      {
        authority,
        host: {
          async queryControlStatus() {
            return { lease_state: helperState };
          },
        },
      },
      "session-a",
    );
    assert.equal(view.present && view.lease.state, "active", helperState);
  }
  const authority = sessionAuthority();
  const reservation = await authority.beginAcquire({ session: "session-a", task: "turn-1" });
  await authority.commitAcquire(reservation.leaseId, "helper-lease-1", "requirement");
  const view = await describeComputerUseSession(
    {
      authority,
      host: {
        async queryControlStatus() {
          throw new Error("helper down");
        },
      },
    },
    "session-a",
  );
  assert.equal(view.present && view.lease.state, "active");
  assert.equal(view.present && view.stopMeaningful, true);
});

test("pause state and stopMeaningful are projected for the owning session", async () => {
  const authority = sessionAuthority();
  reportedSession(authority);
  const reservation = await authority.beginAcquire({ session: "session-a", task: "turn-1" });
  await authority.commitAcquire(reservation.leaseId, "helper-lease-1", "requirement");
  await authority.pause();
  const view = await describeComputerUseSession({ authority, host: undefined }, "session-a");
  assert.equal(view.present && view.paused, true);
  assert.equal(view.present && view.pausedAt, 1_000);
  assert.equal(view.present && view.lease.termination?.reason, "paused");
  const started = sessionAuthority();
  started.reportActivity({
    session: "session-a",
    task: "turn-1",
    callId: "call-2",
    phase: "started",
    method: "click",
    at: 30,
  });
  const running = await describeComputerUseSession(
    { authority: started, host: undefined },
    "session-a",
  );
  assert.equal(running.present && running.stopMeaningful, true);
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const OBSERVATION_ID = "00000000-0000-0000-0000-000000000002";
const OTHER_ID = "00000000-0000-0000-0000-000000000009";

function frameEnv(root: string): NodeJS.ProcessEnv {
  return { ZCODE_HOME: root, HOME: join(root, "not-the-home") };
}

test("observation frame read serves this session's latest recorded frame only", async () => {
  const root = mkFrameRoot();
  try {
    const authority = sessionAuthority();
    const framePath = join(root, "computer-use", "observations", `${OBSERVATION_ID}.png`);
    writeFileSync(framePath, PNG);
    authority.reportActivity({
      session: "session-a",
      task: "turn-1",
      callId: "call-1",
      phase: "completed",
      method: "observe",
      at: 20,
      observation: { id: OBSERVATION_ID, width: 4, height: 4, framePath },
    });
    const deps = { authority, env: frameEnv(root) };
    const frame = await readComputerUseObservationFrame(deps, "session-a", OBSERVATION_ID);
    assert.equal(frame.status, "available");
    assert.equal(frame.mimeType, "image/png");
    assert.equal(frame.byteLength, PNG.byteLength);
    // Another session's request and a foreign observation id are refused without reading.
    assert.equal(
      (await readComputerUseObservationFrame(deps, "session-b", OBSERVATION_ID)).code,
      "forbidden",
    );
    assert.equal(
      (await readComputerUseObservationFrame(deps, "session-a", OTHER_ID)).code,
      "forbidden",
    );
    assert.equal(
      (await readComputerUseObservationFrame(deps, "session-a", "not-a-uuid")).code,
      "forbidden",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observation frame read rejects traversal, swapped names, and paths outside the roots", async () => {
  const root = mkFrameRoot();
  try {
    const authority = sessionAuthority();
    const observations = join(root, "computer-use", "observations");
    const framePath = join(observations, `${OBSERVATION_ID}.png`);
    authority.reportActivity({
      session: "session-a",
      task: "turn-1",
      callId: "call-1",
      phase: "completed",
      method: "observe",
      at: 20,
      observation: { id: OBSERVATION_ID, framePath },
    });
    const deps = { authority, env: frameEnv(root) };
    // A traversal-shaped framePath never matches its own basename gate.
    const traversal = sessionAuthority();
    traversal.reportActivity({
      session: "session-a",
      task: "turn-1",
      callId: "call-1",
      phase: "completed",
      method: "observe",
      at: 20,
      observation: {
        id: OBSERVATION_ID,
        framePath: join(root, "computer-use", "observations", "..", "..", "secrets.png"),
      },
    });
    assert.equal(
      (
        await readComputerUseObservationFrame(
          { authority: traversal, env: frameEnv(root) },
          "session-a",
          OBSERVATION_ID,
        )
      ).code,
      "forbidden",
    );
    // A real file outside the observation roots is refused even when the names line up.
    const outside = join(root, "elsewhere");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, `${OBSERVATION_ID}.png`), PNG);
    const outsideAuthority = sessionAuthority();
    outsideAuthority.reportActivity({
      session: "session-a",
      task: "turn-1",
      callId: "call-1",
      phase: "completed",
      method: "observe",
      at: 20,
      observation: { id: OBSERVATION_ID, framePath: join(outside, `${OBSERVATION_ID}.png`) },
    });
    assert.equal(
      (
        await readComputerUseObservationFrame(
          { authority: outsideAuthority, env: frameEnv(root) },
          "session-a",
          OBSERVATION_ID,
        )
      ).code,
      "forbidden",
    );
    assert.equal(
      (await readComputerUseObservationFrame(deps, "session-a", OBSERVATION_ID)).code,
      "stale",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observation frame read reports stale for pruned frames and refuses non-PNG and oversized bytes", async () => {
  const root = mkFrameRoot();
  try {
    const observations = join(root, "computer-use", "observations");
    const staleAuthority = sessionAuthority();
    staleAuthority.reportActivity({
      session: "session-a",
      task: "t",
      callId: "c",
      phase: "completed",
      method: "observe",
      at: 1,
      observation: {
        id: OBSERVATION_ID,
        framePath: join(observations, `${OBSERVATION_ID}.png`),
      },
    });
    assert.equal(
      (
        await readComputerUseObservationFrame(
          { authority: staleAuthority, env: frameEnv(root) },
          "session-a",
          OBSERVATION_ID,
        )
      ).code,
      "stale",
    );

    writeFileSync(join(observations, `${OBSERVATION_ID}.png`), "not a png at all");
    const fakeAuthority = sessionAuthority();
    fakeAuthority.reportActivity({
      session: "session-a",
      task: "t",
      callId: "c",
      phase: "completed",
      method: "observe",
      at: 1,
      observation: { id: OBSERVATION_ID, framePath: join(observations, `${OBSERVATION_ID}.png`) },
    });
    const deps = { authority: fakeAuthority, env: frameEnv(root) };
    assert.equal(
      (await readComputerUseObservationFrame(deps, "session-a", OBSERVATION_ID)).code,
      "unavailable",
    );

    rmSync(join(observations, `${OBSERVATION_ID}.png`));
    writeFileSync(join(observations, `${OBSERVATION_ID}.png`), Buffer.alloc(9 * 1024 * 1024, PNG));
    assert.equal(
      (await readComputerUseObservationFrame(deps, "session-a", OBSERVATION_ID)).code,
      "too_large",
    );

    rmSync(join(observations, `${OBSERVATION_ID}.png`));
    writeFileSync(join(observations, `${OBSERVATION_ID}.png`), PNG);
    const ok = await readComputerUseObservationFrame(deps, "session-a", OBSERVATION_ID);
    assert.equal(ok.status, "available");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked frame that resolves outside the roots is refused", async () => {
  const root = mkFrameRoot();
  try {
    const observations = join(root, "computer-use", "observations");
    const escapeDir = join(root, "escape");
    mkdirSync(escapeDir, { recursive: true });
    writeFileSync(join(escapeDir, `${OBSERVATION_ID}.png`), PNG);
    symlinkSync(
      join(escapeDir, `${OBSERVATION_ID}.png`),
      join(observations, `${OBSERVATION_ID}.png`),
    );
    const authority = sessionAuthority();
    authority.reportActivity({
      session: "session-a",
      task: "t",
      callId: "c",
      phase: "completed",
      method: "observe",
      at: 1,
      observation: { id: OBSERVATION_ID, framePath: join(observations, `${OBSERVATION_ID}.png`) },
    });
    assert.equal(
      (
        await readComputerUseObservationFrame(
          { authority, env: frameEnv(root) },
          "session-a",
          OBSERVATION_ID,
        )
      ).code,
      "forbidden",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observation roots come only from ZCODE_HOME or the HOME profile", () => {
  const roots = observationRoots({ ZCODE_HOME: "/data/profile/.zcode", HOME: "/Users/x" });
  assert.deepEqual(roots, [
    "/data/profile/.zcode/computer-use/observations",
    "/Users/x/.zcode/computer-use/observations",
  ]);
  assert.deepEqual(observationRoots({}), []);
});

function mkFrameRoot(): string {
  const root = join(tmpdir(), `cua4-frame-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, "computer-use", "observations"), { recursive: true });
  return root;
}
