// Cross-Mode handoff 实机验收驱动（交付/测试基建，不是产品代码）：
// 以真实协议客户端身份启动构建产物 `zcode.cjs app-server --stdio`，
// 沿产品路径发起一次 Coding → Multitask handoff：
//   1. v4/command createSession（workspaceId=工作目录、dynamicWorkflowEnabled=true）
//   2. v4/command startMultitaskHandoff（冻结契约边界输入）
//   3. 作为「用户」应答 Multitask 运行确认闸门（interaction/requestPermission，仅 Multitask）
//      —— 默认 allow（验收路径）；--deny 时 deny（拒绝路径，断言 rejected + 无回链）
//   4. 断言 accepted ACK + 回链 externalRef {kind:"multitask-run"}；随后只读查询 run 目录
// 隔离：HOME / ZCODE_DATA_BASE_DIR 指向临时目录，绝不动用户真实 ~/.zcode。
//
// 用法（先构建 CLI bundle）：
//   node apps/zcode-cli/scripts/cross-mode-handoff-live-acceptance.mjs [--deny] [--cli <path>] \
//     [--workspace <path>] [--data-home <path>] [--settle-wait-ms 15000] [--timeout-ms 180000] \
//     [--print-frames] [--clean-data]
// 退出码：0 = 通过；1 = 断言失败；2 = 超时/进程异常退出。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));

// ── 参数 ──
const args = process.argv.slice(2);
function readOption(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const hasFlag = (name) => args.includes(name);
const CLI_PATH = resolve(
  readOption("--cli", join(here, "..", "packages", "cli", "dist", "zcode.cjs")),
);
const TIMEOUT_MS = Number(readOption("--timeout-ms", "180000"));
const SETTLE_WAIT_MS = Number(readOption("--settle-wait-ms", "15000"));
const PRINT_FRAMES = hasFlag("--print-frames");
const CLEAN_DATA = hasFlag("--clean-data");
const DENY_MODE = hasFlag("--deny");

const runRoot = mkdtempSync(join(tmpdir(), "cross-mode-handoff-live-"));
const dataHome = resolve(readOption("--data-home", join(runRoot, "home")));
const workspace = resolve(readOption("--workspace", join(runRoot, "project")));
for (const dir of [dataHome, workspace]) mkdirSync(dir, { recursive: true });

const DRIVER_CLIENT_ID = "cross-mode-live-acceptance-driver";
const evidence = {
  mode: DENY_MODE ? "deny" : "allow",
  cliPath: CLI_PATH,
  dataHome,
  workspace,
  protocolFramesIn: 0,
  notificationMethods: {},
  storageReady: false,
  createSession: null,
  handoffAck: null,
  permissionRequests: [],
  workflowRuns: null,
};
let handoffRunId = null;

function log(...parts) {
  console.log("[live]", ...parts);
}
function fail(message, code = 1) {
  console.error("[live] FAIL:", message);
  console.log("[live] evidence:", JSON.stringify(evidence, null, 2));
  shutdown(code);
}

// ── 子进程 ──
log("spawning", CLI_PATH, "app-server --stdio");
log("isolated data home:", dataHome);
const child = spawn(process.execPath, [CLI_PATH, "app-server", "--stdio"], {
  cwd: workspace,
  env: {
    ...process.env,
    HOME: dataHome,
    ZCODE_DATA_BASE_DIR: dataHome,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let closing = false;
let exitCode = 2;
const pending = new Map();
let nextRequestSeq = 1;

function shutdown(code) {
  if (closing) return;
  closing = true;
  exitCode = code;
  try {
    child.stdin.end();
  } catch {
    /* already closed */
  }
  setTimeout(() => child.kill("SIGTERM"), 2500).unref();
  setTimeout(() => child.kill("SIGKILL"), 5000).unref();
}

child.on("exit", (code, signal) => {
  log(`child exited (code=${code}, signal=${signal})`);
  if (!closing && code !== 0) {
    fail(`app-server exited early with code=${code} signal=${signal}`);
  }
});

const watchdogTimer = setTimeout(() => {
  log("watchdog fired; shutting down");
  fail(`timeout after ${TIMEOUT_MS}ms`, 2);
}, TIMEOUT_MS);
watchdogTimer.unref();

function send(message) {
  if (PRINT_FRAMES) log("->", JSON.stringify(message).slice(0, 240));
  child.stdin.write(JSON.stringify(message) + "\n");
}

/** 客户端请求；服务器以 {id, result} / {id, error} 应答。 */
function request(method, params, timeoutMs) {
  const id = `driver-${nextRequestSeq++}`;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`request timeout: ${method}`));
    }, timeoutMs);
    timer.unref();
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, method });
    send({ id, method, params });
  });
}

// ── 帧循环（NDJSON，仅以 LF 分帧） ──
let stdoutBuffer = "";
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  let index;
  while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
    const line = stdoutBuffer.slice(0, index);
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (!line.trim()) continue;
    handleFrame(line);
  }
});
child.stderr.on("data", (chunk) => {
  for (const line of chunk.toString("utf8").split("\n")) {
    if (line.trim()) process.stderr.write("[live:stderr] " + line + "\n");
  }
});

function handleFrame(line) {
  evidence.protocolFramesIn += 1;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    log("unparsed frame:", line.slice(0, 200));
    return;
  }
  if (PRINT_FRAMES) log("<-", line.slice(0, 240));

  const hasMethod = typeof message.method === "string";
  const hasId = message.id !== undefined;

  if (hasMethod && hasId) {
    handleReverseRequest(message);
    return;
  }
  if (hasMethod) {
    handleNotification(message);
    return;
  }
  if (hasId) {
    const waiter = pending.get(message.id);
    if (!waiter) {
      log("stray response:", line.slice(0, 200));
      return;
    }
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error !== undefined) {
      waiter.reject(new Error(`${waiter.method}: ${JSON.stringify(message.error)}`));
    } else {
      waiter.resolve(message.result);
    }
  }
}

function handleNotification(message) {
  evidence.notificationMethods[message.method] =
    (evidence.notificationMethods[message.method] ?? 0) + 1;
  if (message.method === "startup/storageState" && message.params?.phase === "ready") {
    evidence.storageReady = true;
  }
}

/** 服务器 → 客户端反向请求：Multitask 运行确认（permission）与运行期偏好。 */
function handleReverseRequest(message) {
  const { method, id, params } = message;
  if (method === "interaction/requestPermission") {
    const request = {
      businessRequestId: params?.requestId,
      toolName: params?.toolName,
      reason: params?.reason,
      riskLevel: params?.riskLevel,
      answeredWith: null,
    };
    evidence.permissionRequests.push(request);
    if (params?.toolName === "Multitask") {
      if (DENY_MODE) {
        request.answeredWith = "deny";
        log("denying Multitask run confirmation (--deny)");
        send({
          id,
          result: { decision: "deny", reason: "live acceptance driver: user denied the run confirmation" },
        });
      } else {
        request.answeredWith = "allow";
        log("approving Multitask run confirmation");
        send({
          id,
          result: { decision: "allow", reason: "live acceptance driver: approve run confirmation" },
        });
      }
    } else {
      request.answeredWith = "deny";
      log("denying non-Multitask permission request:", params?.toolName);
      send({
        id,
        result: { decision: "deny", reason: "live acceptance driver: only Multitask is approved" },
      });
    }
    return;
  }
  if (method === "session/requestRuntimePreferences") {
    send({
      id,
      result: {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
      },
    });
    return;
  }
  log("unhandled reverse request:", method);
  send({ id, error: { code: -32601, message: `driver does not implement ${method}` } });
}

// ── 验收主流程 ──
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function main() {
  const bootDeadline = Date.now() + 10000;
  while (!evidence.storageReady && Date.now() < bootDeadline) {
    await sleep(200);
  }
  log("storage ready:", evidence.storageReady);

  // 1) 新建会话（draft）：本地 workspaceId = 工作目录；动态工作流门禁显式开启。
  const createSessionAck = await request(
    "v4/command",
    {
      commandId: randomUUID(),
      clientId: DRIVER_CLIENT_ID,
      sessionId: null,
      type: "createSession",
      payload: {
        workspaceId: workspace,
        dynamicWorkflowEnabled: true,
        config: { mode: "build" },
      },
      issuedAt: Date.now(),
    },
    30000,
  );
  evidence.createSession = {
    status: createSessionAck?.status,
    reasonCode: createSessionAck?.reasonCode ?? null,
    sessionId: createSessionAck?.result?.sessionId ?? null,
  };
  if (createSessionAck?.status !== "accepted" || !createSessionAck?.result?.sessionId) {
    return fail(`createSession not accepted: ${JSON.stringify(createSessionAck).slice(0, 400)}`);
  }
  const sessionId = createSessionAck.result.sessionId;
  log("session:", sessionId);

  // 2) 发起 handoff（生产 V4 命令；服务端等待运行确认闸门后回 ACK）。
  const handoffAck = await request(
    "v4/command",
    {
      commandId: randomUUID(),
      clientId: DRIVER_CLIENT_ID,
      sessionId,
      type: "startMultitaskHandoff",
      payload: {
        objective: "Live acceptance: Coding → Multitask handoff through the production executor",
        context: [
          {
            label: "Acceptance driver",
            content:
              "Handoff issued by the live-acceptance driver through the real V4 command channel.",
          },
        ],
        constraints: ["Keep changes additive"],
        permissions: ["repo-read", "repo-write"],
        returnPolicy: "summary",
        linkedProject: { kind: "project", id: "acevra-cross-mode-multitask" },
        plan: {
          name: "Live acceptance handoff",
          workers: [
            { id: "reader", role: "Repository reader", access: "read" },
            { id: "writer", role: "Additive change writer", access: "write" },
          ],
          tasks: [
            {
              id: "inspect",
              worker: "reader",
              prompt: "Inspect the project layout and report the top-level entries.",
              dependsOn: [],
            },
            {
              id: "report",
              worker: "writer",
              prompt: "Summarize the inspection result in one short paragraph.",
              dependsOn: ["inspect"],
            },
          ],
        },
      },
      issuedAt: Date.now(),
    },
    120000,
  );
  evidence.handoffAck = {
    status: handoffAck?.status,
    reasonCode: handoffAck?.reasonCode ?? null,
    message: handoffAck?.message ?? null,
    result: handoffAck?.result ?? null,
  };
  log("handoff ACK:", JSON.stringify(handoffAck).slice(0, 500));

  const result = handoffAck?.result;
  if (handoffAck?.status !== "accepted" || result?.type !== "startMultitaskHandoff") {
    return fail(`handoff command not executed: ${JSON.stringify(evidence.handoffAck)}`);
  }

  if (DENY_MODE) {
    // 拒绝路径：闸门拒绝 ⇒ 服务返回 rejected 结果、无回链，且记录保持可重试语义。
    if (result.status !== "rejected" || result.externalRef !== null || !result.reason) {
      return fail(`deny path shape unexpected: ${JSON.stringify(result)}`);
    }
    log("deny path OK:", result.reason);
  } else {
    // 验收路径：accepted + 回链。
    if (
      result.status !== "accepted" ||
      result.externalRef?.kind !== "multitask-run" ||
      typeof result.externalRef?.id !== "string"
    ) {
      return fail(`handoff not accepted/reachable: ${JSON.stringify(evidence.handoffAck)}`);
    }
    handoffRunId = result.externalRef.id;
    log("handoff accepted:", result.handoffId, "→ run", handoffRunId);
  }

  // 3) 观察窗口后只读查询 run 目录（best effort；老 CLI 无此查询时记录错误即可）。
  const settleDeadline = Date.now() + SETTLE_WAIT_MS;
  while (Date.now() < settleDeadline) {
    await sleep(500);
  }
  try {
    const runs = await request("v4/conversation/workflowRuns", { sessionId, limit: 8 }, 15000);
    evidence.workflowRuns = runs?.runs ?? null;
  } catch (error) {
    evidence.workflowRuns = { error: error instanceof Error ? error.message : String(error) };
  }

  console.log(
    "[live] PASS (" +
      evidence.mode +
      "): handoff " +
      result.handoffId +
      (handoffRunId ? " → multitask-run:" + handoffRunId : " → rejected without run"),
  );
  console.log("[live] evidence:", JSON.stringify(evidence, null, 2));
  shutdown(0);
}

process.on("exit", () => {
  if (CLEAN_DATA && exitCode === 0) {
    try {
      rmSync(runRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

main().catch((error) => {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
});
