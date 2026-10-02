// Foreground-observation ledger: only Helper-issued foreground geometry may open the approval
// gate, because a pid-only observation can never produce a lease (and must never cost the user
// an Allow).
//
// Run: node --test packages/zcode-cua/test/foreground-observations.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  forgetForegroundObservations,
  hasForegroundObservation,
  rememberForegroundObservations,
} from "../foreground-observations.js";

const FG_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const TREE_ID = "AAAAAAAA-0000-4000-8000-000000000002";

describe("foreground observation ledger", () => {
  it("records a Helper-issued foreground id and recognises it", () => {
    const store = new Map();
    rememberForegroundObservations(store, "session-a", {
      foreground_geometry: { observation_id: FG_ID },
      tree: { observation_id: TREE_ID },
    });
    assert.equal(hasForegroundObservation(store, "session-a", FG_ID), true);
  });

  it("never treats a semantic tree id as foreground geometry", () => {
    const store = new Map();
    rememberForegroundObservations(store, "session-a", {
      tree: { observation_id: TREE_ID },
    });
    // pid-only 观察没有 foreground_geometry：台账保持为空，acquire_control 会如实拒绝。
    assert.equal(hasForegroundObservation(store, "session-a", TREE_ID), false);
    assert.equal(hasForegroundObservation(store, "session-a", FG_ID), false);
  });

  it("scopes ids to their session and forgets them on teardown", () => {
    const store = new Map();
    rememberForegroundObservations(store, "session-a", {
      foreground_geometry: { observation_id: FG_ID },
    });
    assert.equal(hasForegroundObservation(store, "session-b", FG_ID), false);
    forgetForegroundObservations(store, "session-a");
    assert.equal(hasForegroundObservation(store, "session-a", FG_ID), false);
  });

  it("bounds the ledger so a long session cannot grow it without limit", () => {
    const store = new Map();
    for (let index = 0; index < 200; index += 1) {
      rememberForegroundObservations(store, "session-a", {
        foreground_geometry: { observation_id: `id-${index}` },
      });
    }
    const seen = store.get("session-a");
    assert.ok(seen.size <= 64, `ledger must stay bounded, saw ${seen.size}`);
    assert.equal(hasForegroundObservation(store, "session-a", "id-199"), true);
    assert.equal(hasForegroundObservation(store, "session-a", "id-0"), false);
  });
});
