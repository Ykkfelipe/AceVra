// CUA-1 helper identity verification tests.
//
// Run with: node --test packages/zcode-cua/test/identity.test.mjs
//
// What these prove, and what they cannot: the policy below is what the production path
// (`callBrokerMethod` -> every observe-only tool) applies to the identity block a Helper attaches
// to each result. The block itself is produced by the Helper's own `SecCodeCheckValidity` +
// `SecCodeCopySigningInformation` check (see native/cua-helper/CodeIdentity.swift), which is only
// exercised with a real signed bundle — that part is covered by
// `native/cua-helper/run-identity-probe.sh` and archived under the evidence directory. These tests
// cover everything the *client* decides, including the case the client must never get wrong: a
// socket answered by something that is not the helper we expect.

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  DEFAULT_EXPECTED_HELPER_IDENTIFIERS,
  EXPECTED_HELPER_IDS_ENV,
  assertHelperIdentity,
  callBrokerMethod,
  evaluateHelperIdentity,
  probeHelperHealth,
  resolveExpectedHelperIdentifiers,
  serializeResponse,
} from "../broker.js";
import { DEV_CUA_HELPER_BUNDLE_ID, HELPER_BUNDLE_ID } from "../broker-helper-constants.js";

const DEV_HELPER = "dev.acevra.cua-helper.development";

function identity(overrides = {}) {
  return {
    verified: true,
    identifier: DEV_HELPER,
    team_id: "",
    cd_hash: "d2da364aa8e974b717f4acd1e16948867c0d7931",
    requirement: `identifier "${DEV_HELPER}"`,
    ad_hoc: false,
    pid: 1234,
    expected_identifier: "",
    expectation_source: "signature",
    reason: "",
    ...overrides,
  };
}

describe("expected helper identities", () => {
  it("defaults to the identities this repository builds, never a wildcard", () => {
    const expected = resolveExpectedHelperIdentifiers({ env: {} });
    assert.deepEqual(expected, [...DEFAULT_EXPECTED_HELPER_IDENTIFIERS]);
    assert.equal(expected.includes("dev.acevra.cua-helper"), true);
    assert.equal(expected.includes("dev.acevra.cua-helper.development"), true);
    assert.equal(expected.includes("dev.zcode.cua-helper"), false);
    assert.equal(expected.includes("dev.zcode.cua-helper.dev"), false);
    assert.equal(expected.includes(""), false);
  });

  it("lets an explicit environment list replace the default", () => {
    const expected = resolveExpectedHelperIdentifiers({
      env: { [EXPECTED_HELPER_IDS_ENV]: "dev.example.one, dev.example.two ," },
    });
    assert.deepEqual(expected, ["dev.example.one", "dev.example.two"]);
  });

  it("treats an override that names nothing as not configured, not as accept-anything", () => {
    for (const raw of [",", " , ,"]) {
      assert.deepEqual(
        resolveExpectedHelperIdentifiers({ env: { [EXPECTED_HELPER_IDS_ENV]: raw } }),
        [...DEFAULT_EXPECTED_HELPER_IDENTIFIERS],
        `override ${JSON.stringify(raw)} must fall back to the default list`,
      );
    }
  });

  it("stays in step with the bundle-id constants the package exports", () => {
    const expected = resolveExpectedHelperIdentifiers({ env: {} });
    assert.equal(expected.includes(HELPER_BUNDLE_ID), true);
    assert.equal(expected.includes(DEV_CUA_HELPER_BUNDLE_ID), true);
  });
});

describe("identity policy", () => {
  const expected = [DEV_HELPER];

  it("accepts the expected, verified, non-ad-hoc helper", () => {
    assert.deepEqual(evaluateHelperIdentity(identity(), expected), {
      verified: true,
      code: "ok",
      reason: "",
      identifier: DEV_HELPER,
    });
  });

  it("rejects a missing identity block", () => {
    assert.equal(evaluateHelperIdentity(undefined, expected).code, "helper_identity_missing");
  });

  it("rejects a helper that failed its own signature check", () => {
    const verdict = evaluateHelperIdentity(
      identity({ verified: false, identifier: "", reason: "SecStaticCodeCheckValidity failed" }),
      expected,
    );
    assert.equal(verdict.verified, false);
    assert.equal(verdict.code, "helper_identity_unverified");
    assert.match(verdict.reason, /signature check/);
  });

  it("rejects an ad-hoc helper, whose grant dies on the next rebuild", () => {
    assert.equal(
      evaluateHelperIdentity(identity({ ad_hoc: true }), expected).code,
      "helper_identity_adhoc",
    );
  });

  it("rejects a different bundle or signing identity", () => {
    const verdict = evaluateHelperIdentity(identity({ identifier: "com.example.rogue" }), expected);
    assert.equal(verdict.verified, false);
    assert.equal(verdict.code, "helper_identity_mismatch");
    assert.match(verdict.reason, /com\.example\.rogue/);
  });

  it("rejects an unverified identity even when the identifier matches", () => {
    assert.equal(evaluateHelperIdentity(identity({ verified: false }), expected).verified, false);
  });

  it("refuses to treat an empty expectation list as accept-anything", () => {
    const verdict = evaluateHelperIdentity(identity(), []);
    assert.equal(verdict.verified, false);
    assert.equal(verdict.code, "helper_identity_policy_missing");
  });
});

describe("response assertion", () => {
  it("accepts a response whose grant_owner is the verified identifier", () => {
    const verdict = assertHelperIdentity({ grant_owner: DEV_HELPER, helper_identity: identity() }, [
      DEV_HELPER,
    ]);
    assert.equal(verdict.verified, true);
  });

  it("refuses a grant_owner that disagrees with the signature", () => {
    assert.throws(
      () =>
        assertHelperIdentity({ grant_owner: "com.example.claimed", helper_identity: identity() }, [
          DEV_HELPER,
        ]),
      (error) => error.code === "helper_identity_mismatch",
    );
  });

  it("refuses a bare grant_owner with no identity block at all", () => {
    assert.throws(
      () => assertHelperIdentity({ grant_owner: DEV_HELPER }, [DEV_HELPER]),
      (error) => error.code === "helper_identity_missing",
    );
  });
});

describe("socket substitution", () => {
  let dir;
  let socketPath;
  let server;
  let responder;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cua-identity-test-"));
    socketPath = join(dir, "helper.sock");
    server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", () => socket.write(serializeResponse(responder())));
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
  });

  after(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a socket whose answers carry no verified identity", async () => {
    // Anything that can bind the socket path can answer; without the identity block there is
    // nothing to distinguish it from a Helper, so the call fails closed.
    responder = () => ({ ok: true, result: { grant_owner: DEV_HELPER, apps: [] } });
    await assert.rejects(
      () => callBrokerMethod({ socketPath, method: "list_apps" }),
      (error) => error.code === "helper_identity_missing",
    );
  });

  it("refuses a socket that claims the expected id but reports an unverified signature", async () => {
    responder = () => ({
      ok: true,
      result: {
        grant_owner: DEV_HELPER,
        helper_identity: identity({ verified: false, identifier: DEV_HELPER }),
      },
    });
    await assert.rejects(
      () => callBrokerMethod({ socketPath, method: "list_apps" }),
      (error) => error.code === "helper_identity_unverified",
    );
  });

  it("refuses a socket signed as a different bundle", async () => {
    responder = () => ({
      ok: true,
      result: {
        grant_owner: "com.example.rogue",
        helper_identity: identity({ identifier: "com.example.rogue" }),
      },
    });
    await assert.rejects(
      () => callBrokerMethod({ socketPath, method: "list_apps" }),
      (error) => error.code === "helper_identity_mismatch",
    );
  });

  it("accepts the expected helper", async () => {
    responder = () => ({
      ok: true,
      result: { grant_owner: DEV_HELPER, helper_identity: identity(), apps: [{ pid: 1 }] },
    });
    const result = await callBrokerMethod({ socketPath, method: "list_apps" });
    assert.equal(result.apps.length, 1);
  });

  it("scopes the signature requirement to macOS, so a signature-less transport still works", async () => {
    // No helper_identity at all — the shape the Windows development host answers with.
    responder = () => ({
      ok: true,
      result: { grant_owner: null, apps: [], identity: { pid: 4321 } },
    });
    // Asserted explicitly rather than inferred from the host platform, so the case means the same
    // thing on a non-macOS runner, where the default is already off.
    await assert.rejects(
      () =>
        probeHelperHealth(socketPath, {
          timeoutMs: 300,
          perTryTimeoutMs: 200,
          requireVerifiedIdentity: true,
        }),
      (error) => error.code === "helper_identity_missing",
    );
    const health = await probeHelperHealth(socketPath, {
      timeoutMs: 300,
      perTryTimeoutMs: 200,
      requireVerifiedIdentity: false,
    });
    // With no signature to verify, the helper's own report is the only answer available — which is
    // what the Windows ready gate matches against the child process it spawned.
    assert.equal(health.bundleId, null);
    assert.equal(health.pid, 4321);
    assert.equal(health.verified, undefined);
  });
});
