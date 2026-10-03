// Broken-pipe guard (specs/desktop-host-unification.md "Renderer crash recovery and host stdio").
// 2026-10-02 18:28 实测：dev 线束退出后 Host 的 console.log 触发 stream EPIPE，Host 崩溃循环。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { callIgnoringBrokenPipe, installBrokenPipeGuards } from "../src/brokenPipe.js";

const epipe = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

test("an asynchronous EPIPE on a guarded stream is swallowed", () => {
  const stream = new EventEmitter();
  installBrokenPipeGuards([stream]);
  assert.doesNotThrow(() => stream.emit("error", epipe()));
});

test("any other stream error still surfaces", () => {
  const stream = new EventEmitter();
  installBrokenPipeGuards([stream]);
  assert.throws(
    () => stream.emit("error", Object.assign(new Error("boom"), { code: "EIO" })),
    /boom/,
  );
});

test("a synchronous EPIPE from a console write is dropped, other errors propagate", () => {
  assert.doesNotThrow(() =>
    callIgnoringBrokenPipe(() => {
      throw epipe();
    }),
  );
  assert.throws(
    () =>
      callIgnoringBrokenPipe(() => {
        throw new TypeError("not a pipe problem");
      }),
    TypeError,
  );
});

test("writing to a destroyed guarded stream does not raise an uncaught error", async () => {
  const stream = new PassThrough();
  installBrokenPipeGuards([stream]);
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    stream.destroy(epipe());
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.deepEqual(uncaught, []);
});
