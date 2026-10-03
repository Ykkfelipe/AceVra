// Cross-Mode Bot → Coding 实机验收驱动（交付/测试基建，不是产品代码；docs/specs/cross-mode-bot-to-coding.md）。
// 以真实协议客户端身份启动构建产物 `zcode.cjs app-server --stdio`，沿产品路径：
//   phase 1：
//     1. createSession{taskType:"personal_bot"}（Bot 工作区）→ 来源对话 id
//     2. 用冻结契约在驱动侧构建 + 确认 bot → coding packet（与桌面对话框同一组函数）
//     3. createSession{crossModeHandoff:{confirmation}}（项目工作区）→ 断言 ACK 带 crossModeOrigin
//     4. 订阅新会话 → 断言快照 crossModeOrigin
//   phase 2（同一数据目录重启 = 冷恢复）：
//     5. 重新订阅 → 断言 crossModeOrigin 仍在（来自 v4/cross_mode_origin entry）
//     6. 直读 SQLite：交接会话 task_type=interactive、entry 原样存确认快照；Bot 会话未被改写
//   --expect-reject：无可用模型的隔离 HOME 下断言「准入前拒绝、什么都不落库」。
// 隔离：HOME / ZCODE_DATA_BASE_DIR 指向临时目录（或 --data-home），绝不动用户真实 ~/.zcode。
//
// 用法（先构建 CLI bundle；需要 tsx 以加载 shared 源码里的冻结契约）：
//   node --import tsx apps/zcode-cli/scripts/cross-mode-bot-to-coding-live-acceptance.mjs \
//     [--expect-reject] [--data-home <path>] [--cli <path>] [--print-frames] [--clean-data]
// 退出码：0 = 通过；1 = 断言失败；2 = 超时/进程异常退出。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  beginHandoffPreview,
  confirmHandoffPreview,
  createHandoffContextItem,
  createHandoffPacket,
  deserializeHandoffPacket,
} from "../../../packages/shared/src/cross-mode/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const readOption = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const hasFlag = (name) => args.includes(name);
const CLI_PATH = resolve(readOption("--cli", join(here, "..", "packages", "cli", "dist", "zcode.cjs")));
const PRINT_FRAMES = hasFlag("--print-frames");
const EXPECT_REJECT = hasFlag("--expect-reject");
const CLEAN_DATA = hasFlag("--clean-data");
const runRoot = mkdtempSync(join(tmpdir(), "cross-mode-bot-coding-live-"));
const dataHome = resolve(readOption("--data-home", join(runRoot, "home")));
const botWorkspace = join(runRoot, "bot-workspace");
const projectWorkspace = join(runRoot, "project");
for (const dir of [dataHome, botWorkspace, projectWorkspace]) mkdirSync(dir, { recursive: true });

const evidence = { mode: EXPECT_REJECT ? "expect-reject" : "accept", dataHome, runRoot };
const log = (...parts) => console.log("[live]", ...parts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
function assertLive(condition, message) {
  if (!condition) {
    failed = true;
    throw new Error(message);
  }
}

/** 一个 app-server 进程 + NDJSON 协议客户端。 */
function startServer(label) {
  const child = spawn(process.execPath, [CLI_PATH, "app-server", "--stdio"], {
    cwd: projectWorkspace,
    env: { ...process.env, HOME: dataHome, ZCODE_DATA_BASE_DIR: dataHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const frames = [];
  let storageReady = false;
  let seq = 1;
  let buffer = "";
  const send = (message) => {
    if (PRINT_FRAMES) log(label, "->", JSON.stringify(message).slice(0, 240));
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (PRINT_FRAMES) log(label, "<-", line.slice(0, 240));
      const hasMethod = typeof message.method === "string";
      if (hasMethod && message.id !== undefined) {
        // 反向请求：运行期偏好给默认值，其余一律拒绝（交接本身不需要任何权限）。
        if (message.method === "session/requestRuntimePreferences") {
          send({
            id: message.id,
            result: {
              nativeSearchEnhancementsEnabled: false,
              memoryEnabled: false,
              askUserQuestionAutoResolutionEnabled: true,
            },
          });
        } else if (message.method === "interaction/requestPermission") {
          send({ id: message.id, result: { decision: "deny", reason: "live driver" } });
        } else {
          send({ id: message.id, error: { code: -32601, message: "not implemented" } });
        }
        continue;
      }
      if (hasMethod) {
        if (message.method === "startup/storageState" && message.params?.phase === "ready") {
          storageReady = true;
        }
        if (message.method === "v4/conversation/frame") frames.push(message.params);
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error !== undefined) waiter.reject(new Error(`${waiter.method}: ${JSON.stringify(message.error)}`));
      else waiter.resolve(message.result);
    }
  });
  // CLI 日志里与交接相关的行进证据（例如首轮失败原因），其余丢弃。
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (/cross-mode|cross_mode/i.test(line)) (evidence.cliLog ??= []).push(line.slice(0, 400));
    }
  });
  const request = (method, params, timeoutMs = 30000) => {
    const id = `${label}-${seq++}`;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`request timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, method });
      send({ id, method, params });
    });
  };
  const command = (type, sessionId, payload, timeoutMs) =>
    request(
      "v4/command",
      { commandId: randomUUID(), clientId: "cross-mode-bot-coding-live", sessionId, type, payload, issuedAt: Date.now() },
      timeoutMs,
    );
  const ready = async () => {
    const deadline = Date.now() + 15000;
    while (!storageReady && Date.now() < deadline) await sleep(100);
    return storageReady;
  };
  const stop = async () => {
    try {
      child.stdin.end();
    } catch {
      /* closed */
    }
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(5000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  return { child, frames, request, command, ready, stop };
}

async function snapshotOriginFor(server, sessionId, workspacePath) {
  await server.request("v4/conversation/subscribe", {
    topic: `conversation/${sessionId}`,
    connectionId: `live-${randomUUID()}`,
    clientMode: "desktop-continuous",
    workspace: { workspacePath, workspaceKey: workspacePath },
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const frame of server.frames) {
      const text = JSON.stringify(frame);
      if (!text.includes(sessionId)) continue;
      const match = findKey(frame, "crossModeOrigin");
      if (match) return match;
    }
    await sleep(200);
  }
  return null;
}

function findKey(value, key) {
  if (!value || typeof value !== "object") return null;
  if (key in value && value[key]) return value[key];
  for (const child of Object.values(value)) {
    const found = findKey(child, key);
    if (found) return found;
  }
  return null;
}

function openDb() {
  const candidates = [join(dataHome, ".zcode", "cli", "db", "db.sqlite"), join(dataHome, "cli", "db", "db.sqlite")];
  const path = candidates.find((candidate) => existsSync(candidate));
  return path ? new DatabaseSync(path, { readOnly: true }) : null;
}

async function main() {
  log("cli:", CLI_PATH);
  log("isolated data home:", dataHome);
  const a = startServer("A");
  assertLive(await a.ready(), "phase 1 storage never became ready");

  // 1) Bot 来源对话（personal_bot 草稿；只取它的 id 作为契约 conversation 引用）。
  const botAck = await a.command("createSession", null, { workspaceId: botWorkspace, taskType: "personal_bot" });
  assertLive(botAck?.status === "accepted", `bot createSession: ${JSON.stringify(botAck)}`);
  const botSessionId = botAck.result.sessionId;
  evidence.botSessionId = botSessionId;

  // 2) 冻结契约草稿 → 确认（桌面对话框走同一组函数）。
  const packet = createHandoffPacket({
    sourceMode: "bot",
    destinationMode: "coding",
    objective: "Live acceptance: add a reminders settings page",
    returnPolicy: "summary",
    sourceRefs: [{ kind: "conversation", id: botSessionId }],
    context: [
      createHandoffContextItem({ label: "Notes for the work", content: "Reuse the existing form controls." }),
      createHandoffContextItem({ label: "You", content: "UNSELECTED-EXCERPT", included: false }),
    ],
  });
  const confirmed = confirmHandoffPreview(beginHandoffPreview(packet));
  assertLive(confirmed.ok && confirmed.session.confirmation, "driver packet not confirmable");
  const confirmation = confirmed.session.confirmation;
  evidence.handoffId = confirmation.handoffId;

  // 3) 交接。
  const handoffAck = await a.command(
    "createSession",
    null,
    { workspaceId: projectWorkspace, crossModeHandoff: { confirmation: { ...confirmation, warnings: [...confirmation.warnings] } } },
    60000,
  );
  evidence.handoffAck = { status: handoffAck?.status, reasonCode: handoffAck?.reasonCode ?? null, message: handoffAck?.message ?? null, result: handoffAck?.result ?? null };
  log("handoff ACK:", JSON.stringify(evidence.handoffAck).slice(0, 600));

  if (EXPECT_REJECT) {
    assertLive(handoffAck?.status !== "accepted", "expected a rejection without a usable model");
    await a.stop();
    const db = openDb();
    const rows = db ? db.prepare("select id, task_type from session").all() : [];
    const entries = db ? db.prepare("select id from session_entry where type = 'v4/cross_mode_origin'").all() : [];
    evidence.persistedSessions = rows;
    evidence.originEntries = entries;
    assertLive(entries.length === 0, "a rejected handoff must not persist an origin");
    assertLive(!rows.some((row) => row.task_type === "interactive"), "a rejected handoff must not persist a session");
    log("PASS (expect-reject): rejected before admission; nothing persisted");
    return;
  }

  assertLive(handoffAck?.status === "accepted", "handoff createSession not accepted");
  const codingSessionId = handoffAck.result.sessionId;
  const ackOrigin = handoffAck.result.crossModeOrigin;
  evidence.codingSessionId = codingSessionId;
  assertLive(ackOrigin?.handoffId === confirmation.handoffId, "ACK lacks crossModeOrigin");
  assertLive(ackOrigin.sourceRefs?.[0]?.id === botSessionId, "origin does not reference the Bot conversation");
  assertLive(ackOrigin.resultRef?.id === codingSessionId, "origin resultRef is not the new session");

  // 4) 在线快照。
  const liveOrigin = await snapshotOriginFor(a, codingSessionId, projectWorkspace);
  evidence.liveSnapshotOrigin = liveOrigin;
  assertLive(liveOrigin?.handoffId === confirmation.handoffId, "live snapshot lacks crossModeOrigin");
  await sleep(1500);
  await a.stop();

  // 5) 冷恢复。
  const b = startServer("B");
  assertLive(await b.ready(), "phase 2 storage never became ready");
  const coldOrigin = await snapshotOriginFor(b, codingSessionId, projectWorkspace);
  evidence.coldSnapshotOrigin = coldOrigin;
  assertLive(coldOrigin?.handoffId === confirmation.handoffId, "cold snapshot lacks crossModeOrigin");
  await b.stop();

  // 6) 持久事实。
  const db = openDb();
  assertLive(db, "session database not found");
  const session = db.prepare("select id, task_type, title, directory from session where id = ?").get(codingSessionId);
  const entry = db.prepare("select data from session_entry where session_id = ? and type = 'v4/cross_mode_origin'").get(codingSessionId);
  const botRow = db.prepare("select id, task_type from session where id = ?").get(botSessionId);
  const firstUser = db
    .prepare("select p.data from part p join message m on m.id = p.message_id where m.session_id = ? order by p.time_created limit 1")
    .get(codingSessionId);
  evidence.persisted = { session, botRow: botRow ?? null, hasEntry: Boolean(entry), firstPart: firstUser?.data?.slice(0, 300) ?? null };
  assertLive(session?.task_type === "interactive", "handoff session must be a normal interactive Coding session");
  assertLive(session.directory?.startsWith(projectWorkspace), "handoff session is not in the target project");
  const entryData = JSON.parse(entry.data);
  assertLive(entryData.confirmation?.packetJson === confirmation.packetJson, "entry must store the confirmation verbatim");
  assertLive(deserializeHandoffPacket(entryData.confirmation.packetJson).sourceRefs[0].id === botSessionId, "entry packet lost provenance");
  assertLive(!botRow || botRow.task_type === "personal_bot", "Bot session was rewritten");
  if (firstUser?.data) {
    assertLive(!firstUser.data.includes("UNSELECTED-EXCERPT"), "excluded context leaked into the first input");
  }
  db.close();
  log(`PASS (accept): handoff ${confirmation.handoffId} → coding-session:${codingSessionId} (origin live + cold)`);
}

main()
  .then(() => {
    console.log("[live] evidence:", JSON.stringify(evidence, null, 2));
    if (CLEAN_DATA && !failed) rmSync(runRoot, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error("[live] FAIL:", error instanceof Error ? error.message : String(error));
    console.log("[live] evidence:", JSON.stringify(evidence, null, 2));
    process.exit(failed ? 1 : 2);
  });
