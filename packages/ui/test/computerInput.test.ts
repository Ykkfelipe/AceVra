/**
 * Computer tab "Take control" input mapping (acevra-agent-computer.md §3.3): letterboxing,
 * Mac → Windows modifiers, give-back chord, move throttling, wheel conversion.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ComputerInputEvent } from "@zcode/shared";
import {
  createMoveThrottle,
  isGiveBackChord,
  isSafeKeyName,
  mapKeyEvent,
  mapPointToRemote,
  mapRemoteToView,
  wheelClicks,
  type KeyLike,
} from "../src/computers/computerInput.js";

const remote = { width: 1366, height: 768 };

function key(partial: Partial<KeyLike>): KeyLike {
  return {
    code: "",
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

test("maps points through horizontal letterbox bars and drops bar clicks", () => {
  // 1000x1000 view: scale = 1000/1366, drawn height ≈ 562, vertical bars ≈ 219 each.
  const view = { width: 1000, height: 1000 };
  assert.equal(mapPointToRemote({ x: 500, y: 100 }, view, remote), null);
  assert.equal(mapPointToRemote({ x: 500, y: 900 }, view, remote), null);
  assert.deepEqual(mapPointToRemote({ x: 500, y: 500 }, view, remote), { x: 683, y: 384 });
  assert.deepEqual(mapPointToRemote({ x: 0, y: 220 }, view, remote), { x: 0, y: 2 });
});

test("maps points through vertical letterbox bars", () => {
  const view = { width: 2000, height: 768 };
  // Drawn width 1366, side bars 317 px.
  assert.equal(mapPointToRemote({ x: 100, y: 100 }, view, remote), null);
  assert.deepEqual(mapPointToRemote({ x: 317 + 1365, y: 767 }, view, remote), {
    x: 1365,
    y: 767,
  });
});

test("remote cursor maps back into the drawn frame", () => {
  const view = { width: 683, height: 500 };
  const point = mapRemoteToView({ x: 1366, y: 768 }, view, remote);
  assert.ok(point);
  assert.equal(point.x, 683);
  assert.ok(Math.abs(point.y - (500 - (500 - 384) / 2)) < 0.01);
  assert.equal(mapRemoteToView({ x: -1, y: -1 }, view, remote), null);
});

test("Cmd becomes ctrl and Option becomes alt; chorded letters are key names", () => {
  assert.deepEqual(mapKeyEvent(key({ code: "MetaLeft", key: "Meta", metaKey: true }), "down"), [
    { kind: "keydown", key: "ctrl" },
  ]);
  assert.deepEqual(mapKeyEvent(key({ code: "AltRight", key: "Alt" }), "up"), [
    { kind: "keyup", key: "alt" },
  ]);
  assert.deepEqual(mapKeyEvent(key({ code: "KeyC", key: "c", metaKey: true }), "down"), [
    { kind: "keydown", key: "c" },
  ]);
});

test("plain printable characters are sent as text on keydown only", () => {
  assert.deepEqual(mapKeyEvent(key({ code: "KeyA", key: "A", shiftKey: true }), "down"), [
    { kind: "text", text: "A" },
  ]);
  assert.deepEqual(mapKeyEvent(key({ code: "KeyA", key: "A", shiftKey: true }), "up"), []);
  assert.deepEqual(mapKeyEvent(key({ code: "Space", key: " " }), "down"), [
    { kind: "text", text: " " },
  ]);
});

test("named keys use worker names; unmappable keys are dropped", () => {
  assert.deepEqual(mapKeyEvent(key({ code: "Enter", key: "Enter" }), "down"), [
    { kind: "keydown", key: "enter" },
  ]);
  assert.deepEqual(mapKeyEvent(key({ code: "F5", key: "F5" }), "up"), [
    { kind: "keyup", key: "f5" },
  ]);
  // F13 不在映射表也不在安全键名集合里：仍被丢弃（不做文本退化）。
  assert.deepEqual(mapKeyEvent(key({ code: "F13", key: "F13", metaKey: true }), "down"), []);
});

test("Ctrl+Option+Esc is the give-back chord; plain Esc is not", () => {
  assert.equal(isGiveBackChord(key({ code: "Escape", ctrlKey: true, altKey: true })), true);
  assert.equal(isGiveBackChord(key({ code: "Escape" })), false);
  assert.equal(isGiveBackChord(key({ code: "Escape", metaKey: true })), false);
});

test("move throttle sends latest-wins at the configured rate and flushes before clicks", () => {
  let clock = 0;
  const sent: ComputerInputEvent[] = [];
  const timers: Array<() => void> = [];
  const throttle = createMoveThrottle(
    40,
    (event) => sent.push(event),
    (fn) => timers.push(fn),
    () => clock,
  );
  clock = 100;
  throttle.move({ x: 1, y: 1 });
  throttle.move({ x: 2, y: 2 });
  throttle.move({ x: 3, y: 3 });
  assert.deepEqual(sent, [{ kind: "move", x: 1, y: 1 }]);
  assert.equal(timers.length, 1);
  clock = 125;
  timers[0]();
  assert.deepEqual(sent.at(-1), { kind: "move", x: 3, y: 3 });
  clock = 130;
  throttle.move({ x: 4, y: 4 });
  throttle.flush();
  assert.deepEqual(sent.at(-1), { kind: "move", x: 4, y: 4 });
  assert.equal(sent.length, 3);
});

test("wheel deltas become bounded wheel clicks", () => {
  assert.equal(wheelClicks(120, 0), 1);
  assert.equal(wheelClicks(-4, 0), -1);
  assert.equal(wheelClicks(3, 1), 1);
  assert.equal(wheelClicks(100000, 0), 10);
  assert.equal(wheelClicks(0, 0), 0);
});

test("chorded punctuation forwards single-character key names (Ctrl+Shift+;)", () => {
  const down = mapKeyEvent(
    key({ code: "Semicolon", key: ";", ctrlKey: true, shiftKey: true }),
    "down",
  );
  assert.deepEqual(down, [{ kind: "keydown", key: ";" }]);
  const up = mapKeyEvent(key({ code: "Semicolon", key: ";", ctrlKey: true, shiftKey: true }), "up");
  assert.deepEqual(up, [{ kind: "keyup", key: ";" }]);
});

test("every explicit punctuation code maps and the safe-name check accepts exactly that set", () => {
  const codes = [
    "Minus",
    "Equal",
    "BracketLeft",
    "BracketRight",
    "Backslash",
    "Semicolon",
    "Quote",
    "Comma",
    "Period",
    "Slash",
    "Backquote",
  ];
  const chars = ["-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`"];
  for (const [index, code] of codes.entries()) {
    assert.deepEqual(
      mapKeyEvent(key({ code, key: chars[index], ctrlKey: true, shiftKey: true }), "down"),
      [{ kind: "keydown", key: chars[index] }],
    );
    assert.equal(isSafeKeyName(chars[index]), true);
  }
  // 未知/危险键名仍被丢弃（不做文本退化）。
  assert.equal(isSafeKeyName("F13"), false);
  assert.equal(isSafeKeyName("enter"), true);
  assert.equal(isSafeKeyName("x"), true);
  assert.deepEqual(mapKeyEvent(key({ code: "F13", key: "F13" }), "down"), []);
});

test("plain printable keys stay on the text path, not key names", () => {
  assert.deepEqual(mapKeyEvent(key({ code: "KeyA", key: "a" }), "down"), [
    { kind: "text", text: "a" },
  ]);
  assert.deepEqual(mapKeyEvent(key({ code: "KeyA", key: "a" }), "up"), []);
});
