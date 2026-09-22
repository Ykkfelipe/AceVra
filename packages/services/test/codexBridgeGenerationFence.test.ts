/**
 * Codex bridge 代数围栏 — 真实 CodexAppServerBridge + 假 codex 可执行文件（零推理、零依赖）。
 *
 * 安全断言（任务门禁"stale bridge generations cannot satisfy current approvals"）：
 * - 同代内审批应答能到达 app-server（正控制），
 * - bridge stop()/换代后，对旧代 server-request rawId 的重放应答绝不写入新进程 stdin。
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/codexBridgeGenerationFence.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServerBridge } from "../src/accounts/codexAppServerBridge.js";

const fixtureDir = mkdtempSync(path.join(tmpdir(), "codex-bridge-fence-"));
const inboundLog = path.join(fixtureDir, "inbound.jsonl");
const serverScript = path.join(fixtureDir, "fake-app-server.mjs");
const wrapperScript = path.join(fixtureDir, "fake-codex");

// 假 app-server：应答 initialize；对 start-approval 先回 ACK 再下发审批 server-request
// （id 固定 777）；所有入站行原样追加到 inboundLog 供测试断言。
writeFileSync(
  serverScript,
  `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const log = process.env.FAKE_INBOUND_LOG;
const rl = createInterface({ input: process.stdin });
function write(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  appendFileSync(log, line + "\\n");
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake", codexHome: "/fake", platformFamily: "darwin", platformOs: "macos" } });
    return;
  }
  if (msg.method === "start-approval") {
    write({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
    write({ jsonrpc: "2.0", id: 777, method: "item/commandExecution/requestApproval", params: { threadId: "t1", command: "echo hi" } });
  }
});
`,
);
// wrapper：spawn(可执行, ["app-server"])，转发到 node 脚本。
writeFileSync(wrapperScript, `#!/bin/sh\nexec node "${serverScript}"\n`);
spawnSync("chmod", ["+x", wrapperScript]);

function readLog(): string {
  try {
    return readFileSync(inboundLog, "utf8");
  } catch {
    return "";
  }
}

test("approval responses are generation-fenced: a stale rawId cannot satisfy the new process", async () => {
  process.env.FAKE_INBOUND_LOG = inboundLog;
  const bridge = new CodexAppServerBridge({ executablePath: wrapperScript });
  try {
    // 同代正控制：审批 server-request 派发后，respond 必须原样到达 app-server stdin。
    const approvalArrived = new Promise<{ rawId: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("approval server-request never dispatched")), 5_000);
      bridge.onNotification((_method, _params, rawRequest) => {
        if (rawRequest?.method === "item/commandExecution/requestApproval") {
          clearTimeout(timer);
          resolve({ rawId: rawRequest.rawId });
        }
      });
    });
    await bridge.call("start-approval", {});
    const { rawId } = await approvalArrived;
    assert.equal(rawId, 777);
    bridge.respond(rawId, { decision: "accept" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const accepts = readLog().split("\n").filter((line) => {
      try {
        const msg = JSON.parse(line);
        return msg.id === 777 && msg.result !== undefined;
      } catch {
        return false;
      }
    });
    assert.equal(accepts.length, 1, "same-generation approval response must reach the server exactly once");

    // 换代（stop 杀进程、清登记）：对旧代 rawId 的重放应答绝不进入任何后续进程。
    bridge.stop();
    await bridge.call("initialize", {}); // 触发新进程（generation+1）
    bridge.respond(rawId, { decision: "accept" }); // stale 重放
    await new Promise((resolve) => setTimeout(resolve, 150));
    const acceptsAfterRestart = readLog().split("\n").filter((line) => {
      try {
        const msg = JSON.parse(line);
        return msg.id === 777 && msg.result !== undefined;
      } catch {
        return false;
      }
    });
    assert.equal(
      acceptsAfterRestart.length,
      1,
      "stale-generation approval replay must never be written to the new process",
    );
  } finally {
    bridge.dispose();
    delete process.env.FAKE_INBOUND_LOG;
  }
});
