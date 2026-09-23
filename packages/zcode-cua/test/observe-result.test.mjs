// CUA-1 observation-boundary tests: what a model is allowed to receive.
//
// Run with: node --test packages/zcode-cua/test/observe-result.test.mjs
//
// The helper bounds what it reads (ObservationLimits in Observe.swift); these tests cover the
// second, independent boundary: what leaves the host. A realistic `observe` payload is used so the
// assertions describe the real shape rather than a toy one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OBSERVE_LIMITS,
  hasDeliverablePayload,
  redactHostPaths,
  sanitizeObservationResult,
  serializedBytes,
} from "../observe-result.js";

function observePayload(overrides = {}) {
  return {
    pid: 4711,
    limits: { max_elements: 1500, max_depth: 25, max_string_characters: 512 },
    image: {
      ok: true,
      path: "/Users/someone/.zcode/computer-use/observations/6f3b.png",
      observation_id: "6f3b",
      width: 800,
      height: 600,
      scale: 2,
      distinct_sampled_colors: 42,
      blank: false,
    },
    tree: {
      ok: true,
      element_count: 3,
      truncated: false,
      elements: [
        { index: 0, role: "AXWindow", label: "Untitled", frame: { x: 0, y: 0, w: 800, h: 600 } },
        { index: 1, role: "AXButton", label: "OK", actions: ["AXPress"] },
        { index: 2, role: "AXStaticText", label: "hello", value: "hello" },
      ],
    },
    route: "screencapturekit+ax",
    delivery: { mode: "background" },
    effect: "confirmed",
    evidence: [{ kind: "pixel_stats", width: 800, height: 600, blank: false }],
    helper_identity: { verified: true, identifier: "dev.acevra.cua-helper.development", pid: 99 },
    ...overrides,
  };
}

describe("host path disclosure", () => {
  it("replaces the frame's host path with an opaque reference", () => {
    const { result, redactions } = sanitizeObservationResult(observePayload());
    assert.equal(result.image.path, undefined);
    assert.equal(result.image.reference, "helper-observation:6f3b");
    assert.deepEqual(redactions.pathKeysDropped, ["path"]);
  });

  it("contains no absolute host path anywhere in the serialized result", () => {
    const { result } = sanitizeObservationResult(
      observePayload({
        // The most likely leak shape: a path inside a message rather than in a `path` field.
        error:
          "capture failed: could not write /Users/someone/.zcode/computer-use/observations/x.png",
        tree: {
          ok: true,
          element_count: 1,
          elements: [{ index: 0, role: "AXTextField", value: "/Volumes/Work/secret.docx" }],
        },
      }),
    );
    const text = JSON.stringify(result);
    assert.equal(/\/Users\/|\/Volumes\/|\/private\/var\/|\/tmp\//.test(text), false, text);
    assert.match(text, /redacted-host-path/);
  });

  it("keeps the facts a caller reasons about", () => {
    const { result } = sanitizeObservationResult(observePayload());
    assert.equal(result.image.width, 800);
    assert.equal(result.image.blank, false);
    assert.equal(result.effect, "confirmed");
    assert.equal(result.route, "screencapturekit+ax");
    assert.equal(result.tree.elements.length, 3);
  });

  it("never mutates the input", () => {
    const input = observePayload();
    sanitizeObservationResult(input);
    assert.equal("path" in input.image, true);
  });
});

describe("bounds", () => {
  it("truncates over-long AX text", () => {
    const long = "a".repeat(OBSERVE_LIMITS.maxStringCharacters * 3);
    const { result, redactions } = sanitizeObservationResult(
      observePayload({
        tree: {
          ok: true,
          elements: [{ index: 0, role: "AXStaticText", label: long, value: long }],
        },
      }),
    );
    assert.equal(result.tree.elements[0].label.length, OBSERVE_LIMITS.maxStringCharacters + 1);
    assert.ok(redactions.stringsTruncated >= 2);
  });

  it("drops elements past the element ceiling and says so", () => {
    const elements = Array.from({ length: OBSERVE_LIMITS.maxElements + 25 }, (_, index) => ({
      index,
      role: "AXButton",
      label: `b${index}`,
    }));
    const { result, redactions } = sanitizeObservationResult(
      observePayload({ tree: { ok: true, element_count: elements.length, elements } }),
    );
    assert.equal(result.tree.elements.length, OBSERVE_LIMITS.maxElements);
    assert.equal(result.tree.truncated, true);
    assert.equal(redactions.elementsDropped, 25);
  });

  it("bounds the whole serialized result, not just the element count", () => {
    // Many small elements: under the element ceiling, far over the byte budget.
    const elements = Array.from({ length: OBSERVE_LIMITS.maxElements }, (_, index) => ({
      index,
      role: "AXStaticText",
      label: "x".repeat(OBSERVE_LIMITS.maxStringCharacters),
    }));
    const { result, limits, redactions } = sanitizeObservationResult(
      observePayload({ tree: { ok: true, element_count: elements.length, elements } }),
    );
    assert.equal(limits.exceededBytes, true);
    assert.equal(result.truncated_for_size, true);
    assert.ok(serializedBytes(result) <= OBSERVE_LIMITS.maxResultBytes);
    assert.ok(redactions.elementsDropped > 0);
  });

  it("bounds action lists", () => {
    const actions = Array.from({ length: 200 }, (_, index) => `AXAction${index}`);
    const { result } = sanitizeObservationResult(
      observePayload({ tree: { ok: true, elements: [{ index: 0, role: "AXButton", actions }] } }),
    );
    assert.equal(result.tree.elements[0].actions.length, OBSERVE_LIMITS.maxActionsPerElement);
  });

  it("truncates a pathological window list", () => {
    const windows = Array.from({ length: OBSERVE_LIMITS.maxWindows + 10 }, (_, index) => ({
      window_id: index,
      title: "w",
    }));
    const { result } = sanitizeObservationResult({ windows, count: windows.length });
    assert.equal(result.windows.length, OBSERVE_LIMITS.maxWindows);
    assert.equal(result.truncated, true);
  });

  it("bounds a list_windows payload that is under its row cap but over the byte budget", () => {
    // 500 rows are allowed by the count cap; at the string cap they are still ~550 KiB.
    const windows = Array.from({ length: OBSERVE_LIMITS.maxWindows }, (_, index) => ({
      window_id: index,
      owner: "o".repeat(OBSERVE_LIMITS.maxStringCharacters),
      title: "t".repeat(OBSERVE_LIMITS.maxStringCharacters),
    }));
    const { result, limits } = sanitizeObservationResult({ windows, count: windows.length });
    assert.equal(limits.exceededBytes, true);
    assert.equal(result.truncated_for_size, true);
    assert.ok(
      serializedBytes(result) <= OBSERVE_LIMITS.maxResultBytes,
      `${serializedBytes(result)}`,
    );
    assert.ok(result.windows.length < windows.length);
  });

  it("bounds a payload with no tree at all", () => {
    // `list_apps` has no count cap in the helper, so the bytes have to bound it here.
    const apps = Array.from({ length: 5000 }, (_, index) => ({
      pid: index,
      name: "n".repeat(OBSERVE_LIMITS.maxStringCharacters),
    }));
    const { result, limits } = sanitizeObservationResult({
      apps,
      count: apps.length,
      route: "workspace",
    });
    assert.equal(limits.exceededBytes, true);
    assert.ok(
      serializedBytes(result) <= OBSERVE_LIMITS.maxResultBytes,
      `${serializedBytes(result)}`,
    );
    assert.ok(result.apps.length < apps.length);
  });

  it("falls back to the envelope when nothing list-shaped is left to shrink", () => {
    // One huge JSON *object*: there is no array to trim, so the ladder has to reach its last resort.
    // This is the branch the previous round claimed was covered and was not.
    const blob = {};
    for (let index = 0; index < 1200; index += 1) {
      blob[`field_${index}`] = "x".repeat(OBSERVE_LIMITS.maxStringCharacters);
    }
    const { result, limits } = sanitizeObservationResult({
      route: "screencapturekit",
      effect: "confirmed",
      image: { ok: true, observation_id: "abc", blank: false, width: 10 },
      detail: blob,
    });
    assert.equal(limits.exceededBytes, true);
    assert.equal(result.truncated_for_size, true);
    assert.ok(
      serializedBytes(result) <= OBSERVE_LIMITS.maxResultBytes,
      `${serializedBytes(result)}`,
    );
    assert.match(result.error, /result budget/);
    // The envelope that identifies the observation survives, including the opaque frame reference.
    assert.equal(result.route, "screencapturekit");
    assert.equal(result.effect, "confirmed");
    assert.equal(result.image.reference, "helper-observation:abc");
  });
});

describe("free-text redaction", () => {
  it("redacts absolute host paths out of an arbitrary string", () => {
    assert.equal(
      redactHostPaths("connect ENOENT /Users/someone/.zcode/computer-use/helper.sock"),
      "connect ENOENT <redacted-host-path>",
    );
    assert.equal(redactHostPaths("/var/folders/xy/T/helper.sock"), "<redacted-host-path>");
    assert.equal(redactHostPaths("Settings/General"), "Settings/General");
  });
});

describe("artifact boundary", () => {
  it("an internal observation carries nothing the artifact registry could deliver", () => {
    const { result } = sanitizeObservationResult(observePayload());
    assert.equal(hasDeliverablePayload(result), false);
    assert.equal("artifactDelivery" in result, false);
    assert.equal(result.image.base64, undefined);
  });

  it("flags the shapes that would be deliverable, so a future bridge has to argue with this test", () => {
    assert.equal(hasDeliverablePayload({ artifactDelivery: { status: "delivered" } }), true);
    assert.equal(hasDeliverablePayload({ image: "iVBORw0KGgo=" }), true);
    assert.equal(hasDeliverablePayload({ image: { base64: "iVBORw0KGgo=" } }), true);
  });
});
