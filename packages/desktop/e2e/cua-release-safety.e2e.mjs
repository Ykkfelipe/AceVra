#!/usr/bin/env node
import assert from "node:assert/strict";

if (process.env.ZCODE_DESKTOP_E2E_RUN_ID === undefined || process.env.ZCODE_DESKTOP_E2E !== "1") {
  throw new Error("CUA alpha E2E requires the real E2E run id and build flag");
}
assert.equal(process.env.ZCODE_DESKTOP_E2E, "1");
console.log(
  "[e2e:cua-alpha] safety scenario gate is configured; renderer runner requires built desktop app",
);
