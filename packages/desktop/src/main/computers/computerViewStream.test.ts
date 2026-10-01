/** spec §3.3：relay 的键名白名单与 renderer 一致，显式标点单字符键名可转发。 */
import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeInputEvent } from "./computerViewStream.js";

test("chorded punctuation key names pass the relay sanitizer", () => {
  assert.deepEqual(sanitizeInputEvent({ kind: "keydown", key: ";" }), {
    kind: "keydown",
    key: ";",
  });
  assert.deepEqual(sanitizeInputEvent({ kind: "keyup", key: "/" }), { kind: "keyup", key: "/" });
  assert.deepEqual(sanitizeInputEvent({ kind: "keydown", key: "enter" }), {
    kind: "keydown",
    key: "enter",
  });
});

test("unsafe key names are dropped", () => {
  assert.equal(sanitizeInputEvent({ kind: "keydown", key: "F13" }), null);
  assert.equal(sanitizeInputEvent({ kind: "keydown", key: "" }), null);
  assert.equal(sanitizeInputEvent({ kind: "keydown", key: "ab;cd" }), null);
  assert.equal(sanitizeInputEvent({ kind: "keydown", key: 42 }), null);
});
