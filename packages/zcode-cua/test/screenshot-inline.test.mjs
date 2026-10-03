// A user-requested screenshot reaches the chat as an image (Felipe: the agent saved
// /tmp/calculator_7plus7.png instead of showing it). get_app_state stays reference-only.
//
// Run: node --test packages/zcode-cua/test/screenshot-inline.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createComputerUseRuntime } from "../index.js";

const IDENTITY = {
  verified: true,
  identifier: "dev.acevra.cua-helper",
  cd_hash: "abcd",
  ad_hoc: false,
  pid: 1,
  bundle_validated: true,
  reason: "",
  requirement: "r",
};
const LOCAL = {
  sessionId: "s",
  turnId: "t",
  runtimeScope: "main",
  clientMode: "desktop-continuous",
};
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("screenshot is delivered inline", () => {
  const dir = mkdtempSync(join(tmpdir(), "cua-shot-"));
  const socketPath = join(dir, "h.sock");
  const framePath = join(dir, "frame.png");
  const server = createServer((socket) =>
    socket.once("data", (chunk) => {
      const request = JSON.parse(String(chunk).split("\n")[0]);
      const result = {
        pid: 42,
        effect: "confirmed",
        route: "ax",
        evidence: [],
        tree: { observation_id: "A", elements: [] },
        image: { observation_id: "f1", path: framePath, width: 4, height: 4, blank: false },
        helper_identity: IDENTITY,
      };
      socket.end(`${JSON.stringify({ ok: true, id: request.id, result })}\n`);
    }),
  );
  before(async () => {
    writeFileSync(framePath, PNG);
    await new Promise((resolve) => server.listen(socketPath, resolve));
  });
  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const cua = () => createComputerUseRuntime({ brokerSocketPath: socketPath, platform: "darwin" });

  it("screenshot carries the PNG as an inline image block", async () => {
    const result = await cua().execute({
      toolName: "screenshot",
      arguments: { pid: 42 },
      context: LOCAL,
    });
    const image = result.content.find((block) => block.type === "image");
    assert.ok(image, JSON.stringify(result.content.map((b) => b.type)));
    assert.equal(image.inline_screenshot, true);
    // CUA-1.6：默认截图是 agent 观察帧，运行时必须显式标记非用户要求。
    assert.equal(image.requested_by_user, false);
    assert.equal(image.mimeType, "image/png");
    assert.equal(Buffer.from(image.data, "base64").equals(PNG), true);
    const text = result.content.find((block) => block.type === "text").text;
    assert.equal(text.includes(dir), false, "the host frame path never reaches the model");
  });

  it("for_user:true marks the frame as user-requested", async () => {
    const result = await cua().execute({
      toolName: "screenshot",
      arguments: { pid: 42, for_user: true },
      context: LOCAL,
    });
    const image = result.content.find((block) => block.type === "image");
    assert.ok(image);
    assert.equal(image.requested_by_user, true);
  });

  it("get_app_state stays reference-only", async () => {
    const result = await cua().execute({
      toolName: "get_app_state",
      arguments: { pid: 42 },
      context: LOCAL,
    });
    assert.equal(
      result.content.some((block) => block.type === "image"),
      false,
    );
  });
});
