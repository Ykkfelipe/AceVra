/**
 * RemoteComputer 截图 display（acevra-agent-computer.md §3.5）的分流契约：
 * - showToUser=true 的 screenshot → image 通道（聊天主流）；
 * - 未声明的自查 screenshot → observationImage 通道（仅工具详情）；
 * - 非 screenshot 动作与超限图片不产 display 图；模型结果不受影响。
 *
 * Run: cd apps/zcode-cli && mise exec -- node --import tsx --test packages/core/test/remote-computer-result-display.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createToolResultDisplay } from "../src/tool/executor/result-display.js";

const image = { mimeType: "image/jpeg", base64: "ZGVsbA==", width: 1366, height: 768 };

function remoteOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetId: "ssh:dell",
    action: "screenshot",
    screen: { width: 1366, height: 768 },
    message: "Screenshot of 1366x768.",
    image,
    ...overrides,
  };
}

test("showToUser screenshots go to the chat-flow image channel", () => {
  const display = createToolResultDisplay("RemoteComputer", remoteOutput({ showToUser: true }));
  assert.equal(display?.kind, "remote_computer");
  assert.deepEqual(
    display && "image" in display ? display.image : undefined,
    { base64: "ZGVsbA==", mimeType: "image/jpeg" },
  );
  assert.ok(!("observationImage" in (display ?? {})));
});

test("agent-internal screenshots go to the observation channel, never the chat flow", () => {
  const display = createToolResultDisplay("RemoteComputer", remoteOutput());
  assert.equal(display?.kind, "remote_computer");
  assert.ok(!("image" in (display ?? {})));
  assert.deepEqual(
    display && "observationImage" in display ? display.observationImage : undefined,
    { base64: "ZGVsbA==", mimeType: "image/jpeg" },
  );
});

test("oversized images are marked truncated without an image, actions keep no display", () => {
  const oversized = createToolResultDisplay(
    "RemoteComputer",
    remoteOutput({ showToUser: true, image: { ...image, base64: "A".repeat(256 * 1024 + 1) } }),
  );
  assert.equal(oversized && "truncated" in oversized ? oversized.truncated : undefined, true);
  assert.ok(!("image" in (oversized ?? {})));

  const click = createToolResultDisplay("RemoteComputer", {
    targetId: "ssh:dell",
    action: "click",
    screen: { width: 1366, height: 768 },
    message: "Done.",
  });
  assert.equal(click, undefined);
});
