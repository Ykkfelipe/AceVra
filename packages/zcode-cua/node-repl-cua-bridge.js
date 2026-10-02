import { resolveComputerUseDeliveryContext } from "./computer-surface.js";
// Computer Use node_repl bridge —— 两个合法 node_repl 执行面共用的唯一实现。
//
// 背景：CLI 里 `node_repl.js` 有两个合法执行面：
//   1) MCP 宿主（apps/zcode-cli/packages/node-repl-host）：进程内 stdio MCP server；
//   2) core 内置 handler（apps/zcode-cli/packages/core/src/tool/handlers/node-repl.ts）：
//      同进程 NodeReplSession。
// 此前 bridge/facade 只在 MCP 宿主里构建，core handler 的 cell 天生没有 host bridge，
// setupComputerUseRuntime() 只能失败（packaged 实测 bridgeBefore=false）。把实现移到这里，
// 两个面共用同一份协议，任何一面都不能再各自漂移。
//
// 边界职责：
//   - 本模块**只负责 bridge 构造与本地代理 broker**，不发现/不读取任何原始凭据；
//   - 能力获取（captured broker tuple → ComputerUseRuntime）由调用方在自己可信进程内完成，
//     只把 { socketPath, token } 形式的本地连接传进来；
//   - cell globals 里只出现 symbol-keyed bridge，绝不出现 socket/token 值。
//
// 依赖约束：只能用 node: 内置模块与本包的纯模块（capability-contract.js）。core 依赖本包，
// 本包不能反向依赖 @zcode/core / 宿主包。

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveComputerUseMethod } from "./capability-contract.js";
import { COMPUTER_USE_COMPAT_ALIASES, COMPUTER_USE_SURFACE } from "./computer-surface.js";

export const NODE_REPL_CUA_BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.computer-use-bridge");
export const CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Computer Use is not available in subagent";
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// cell 侧：bridge globals + facade 安装
// ---------------------------------------------------------------------------

/**
 * 安装 host-provided `agent.computerUse` facade（每次 cell 执行）。
 *
 * 官方 computer-use skill 的契约是 shared node_repl host 在 cell 之前装好客户端；
 * plugin 的 scripts/computer-use-client.mjs 只是给“暴露 session bridge 的宿主”用的
 * 兼容 bootstrap —— 它读的正是这里安装的 symbol。没有 bridge（未启用 CUA / 凭据缺失）
 * 时保持 no-op：facade 由 bridge 构建，凭据缺失时 bridge 仍在但调用会如实报 unavailable，
 * 绝不凭空造客户端。
 */
export function prepareComputerUseRuntimeGlobals(globals) {
  const bridge = readNodeReplCuaRuntimeBridge(globals);
  if (!bridge) return;
  const agent = (globals.agent ??= {});
  agent.computerUse = createComputerUseFacade(bridge);
}

function readNodeReplCuaRuntimeBridge(globals) {
  const candidate = globals[NODE_REPL_CUA_BRIDGE_SYMBOL];
  if (!candidate || typeof candidate.call !== "function") return undefined;
  return candidate;
}

/** 可枚举的 canonical 方法名（含 describe）；兼容别名可调用但不枚举。 */
const FACADE_METHOD_NAMES = Object.freeze([
  "describe",
  ...COMPUTER_USE_SURFACE.map((entry) => entry.name),
]);
const FACADE_CALLABLE = new Set([
  ...FACADE_METHOD_NAMES,
  ...Object.keys(COMPUTER_USE_COMPAT_ALIASES),
]);

/**
 * 修复依据（实测 agent 花数分钟猜 API）：旧 facade 把任意属性都映射成函数、却枚举不出任何键，
 * `typeof computerUse.press === "function"` 与 `Object.keys(computerUse) → []` 都在误导模型。
 * 现在只有 canonical 名字（+ 两个历史别名）是函数，`Object.keys` 列出真实方法，未知名字为
 * undefined；`describe()` 返回带参数形状与本会话可用性的完整清单。
 */
function createComputerUseFacade(bridge) {
  const call = (name) => async (input) => {
    bridge.assertAvailable?.();
    return await bridge.call(name, input ?? {});
  };
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        if (property === "documentationRoot") return bridge.documentationRoot;
        return FACADE_CALLABLE.has(property) ? call(property) : undefined;
      },
      has(_target, property) {
        return typeof property === "string" && FACADE_CALLABLE.has(property);
      },
      ownKeys() {
        return [...FACADE_METHOD_NAMES];
      },
      getOwnPropertyDescriptor(_target, property) {
        if (typeof property !== "string" || !FACADE_METHOD_NAMES.includes(property)) {
          return undefined;
        }
        return { configurable: true, enumerable: true, writable: false, value: call(property) };
      },
    },
  );
}

/**
 * 构造 symbol-keyed bridge globals。
 *
 * `broker` 是本地代理连接（见 createNodeReplCuaBroker）；缺省时 bridge 仍然存在，
 * 但 assertAvailable 会以既有语义抛出 unavailable（保持与 MCP 宿主完全一致的行为）。
 */
export function createComputerUseBridgeGlobals(input) {
  const assertActive = () => {
    const active = input.getActiveCall();
    if (!active || active.generation !== input.generation) {
      throw new Error("Computer Use runtime binding is stale after kernel reset");
    }
    return active;
  };
  const assertAvailable = () => {
    const active = assertActive();
    if (active.requestMeta?.runtime_scope === "subagent") {
      throw new Error(CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE);
    }
    if (!input.broker) {
      throw new Error("Computer Use is unavailable for this node_repl session");
    }
    return active;
  };

  const bridge = {
    documentationRoot: input.documentationRoot,
    assertAvailable: () => {
      assertAvailable();
    },
    call: async (method, methodInput) => {
      const active = assertAvailable();
      // canonical 操作身份在宿主这一跳记录（调用前记录：失败的调用同样是一次已知操作，
      // 工具行应显示「Looking at Notes · Operation failed」而不是模型标题）。
      const operation = canonicalCuaOperation(method);
      if (operation) input.session().recordCuaOperation?.(operation);
      const result = await sendCuaBrokerRequest(
        input.broker,
        {
          method,
          input: methodInput,
          context: requestContext(active.requestMeta),
        },
        active.signal,
      );
      assertActive();
      if (result.responseMeta) input.session().mergeResponseMeta(result.responseMeta);
      // 用户要的截图：运行时随 screenshot 结果带回的 PNG 以图片块进入本次 cell 输出（聊天可见），
      // 并从返回给 cell 的对象里移除，模型代码不会把整张图 stringify 进文本。
      const inlineImage = takeInlineScreenshot(result.result);
      if (inlineImage) input.session().emitHostImage?.(inlineImage);
      // 目标应用身份必须在这里取：broker 响应是模型看不见也改不了的一跳。
      const app = readPrimaryAppIdentity(result.result);
      if (app) input.session().recordCuaAppIdentity(app);
      return result.result;
    },
  };

  return { [NODE_REPL_CUA_BRIDGE_SYMBOL]: bridge };
}

/** Remove and return the runtime's inline screenshot image block, if the result carries one. */
function takeInlineScreenshot(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) return undefined;
  const index = result.content.findIndex(
    (block) => block?.type === "image" && block.inline_screenshot === true,
  );
  if (index < 0) return undefined;
  const [block] = result.content.splice(index, 1);
  return typeof block.data === "string" && typeof block.mimeType === "string"
    ? { base64: block.data, mimeType: block.mimeType }
    : undefined;
}

const CUA_OPERATION_PATTERN = /^[a-z0-9_.]{1,64}$/iu;

/** facade 属性名 → canonical 方法名（`get_app_state` ⇒ `observe`，`computer.click` ⇒ `click`）。 */
function canonicalCuaOperation(method) {
  if (typeof method !== "string" || !CUA_OPERATION_PATTERN.test(method)) return undefined;
  const mapped = resolveComputerUseMethod(method);
  if (mapped) return mapped;
  return method.startsWith("computer.") ? method.slice("computer.".length) : method;
}

function readPrimaryAppIdentity(result) {
  const meta = result?._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const associations = meta["zcode.cua/app-associations-v1"];
  if (!associations || typeof associations !== "object" || Array.isArray(associations)) {
    return undefined;
  }
  const primary = associations.primary;
  if (!primary || typeof primary !== "object" || Array.isArray(primary)) return undefined;
  const { appKey, displayName } = primary;
  if (typeof appKey !== "string" || !appKey.trim()) return undefined;
  return {
    appKey: appKey.trim(),
    ...(typeof displayName === "string" && displayName.trim()
      ? { displayName: displayName.trim() }
      : {}),
  };
}

function requestContext(meta) {
  const stringMeta = (key) => {
    const value = meta?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const sessionId = stringMeta("session_id");
  if (!sessionId) throw new Error("node_repl CUA request is missing session_id metadata");
  const workspacePath = stringMeta("workspace_path");
  const workspaceIdentity = stringMeta("workspace_identity");
  const workspaceKey = stringMeta("workspace_key") ?? workspaceIdentity ?? workspacePath;
  if (!workspaceKey) throw new Error("node_repl CUA request is missing workspaceKey metadata");
  const { clientMode, deliveryKind } = resolveComputerUseDeliveryContext({
    clientMode: stringMeta("client_mode"),
    deliveryKind: stringMeta("delivery_kind"),
  });
  return {
    runtimeScope: meta?.runtime_scope === "subagent" ? "subagent" : "main",
    sessionId,
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    workspaceKey,
    ...(stringMeta("remote_session_id")
      ? { remoteSessionId: stringMeta("remote_session_id") }
      : {}),
    ...(stringMeta("turn_id") ? { turnId: stringMeta("turn_id") } : {}),
    clientMode,
    deliveryKind,
    ...(stringMeta("trace_id")
      ? {
          trace: {
            traceId: stringMeta("trace_id"),
            ...(stringMeta("span_id") ? { spanId: stringMeta("span_id") } : {}),
            ...(stringMeta("parent_span_id") ? { parentSpanId: stringMeta("parent_span_id") } : {}),
          },
        }
      : {}),
  };
}

async function sendCuaBrokerRequest(broker, request, signal) {
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const socket = createConnection(broker.socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("Computer Use broker returned no response"));
    };
    const onAbort = () => finish(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, token: broker.token, ...request })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        finish(new Error("Computer Use broker response exceeded the 32 MiB limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const payload = JSON.parse(buffer.slice(0, newline));
        if (payload.id !== id) throw new Error("Computer Use broker response id mismatch");
        if (payload.ok !== true)
          throw new Error(
            typeof payload.error === "string" ? payload.error : "Computer Use broker failed",
          );
        if (!payload.result) throw new Error("Computer Use broker returned no result");
        finish(undefined, { result: payload.result, responseMeta: payload.responseMeta });
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
    socket.once("close", () => {
      if (!settled) finish(new Error("Computer Use broker closed before returning a response"));
    });
    if (signal.aborted) onAbort();
  });
}

// ---------------------------------------------------------------------------
// runtime 侧：进程内代理 broker（持有已获授权的 ComputerUseRuntime）
// ---------------------------------------------------------------------------

/**
 * 本地代理 broker：cell 里的 bridge 只连到这个进程内 socket，由持有 `runtime` 的可信
 * 宿主/处理器代执行。`runtime` 只出现在构造参数里，绝不进入 cell globals。
 */
export function createNodeReplCuaBroker(input) {
  const socketPath =
    input.platform === "win32"
      ? `\\\\.\\pipe\\zcode-node-repl-cua-${randomUUID()}`
      : join(tmpdir(), `znrc-${randomUUID()}.sock`);
  const token = randomBytes(32).toString("hex");
  const server = createServer((socket) => {
    void handleSocket(socket, input.runtime, token).catch((error) => {
      input.logger?.warn("Node REPL CUA broker request failed", {
        event: "node_repl.cua_broker.request.failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  server.on("error", (error) => {
    input.logger?.error("Node REPL CUA broker failed", error, {
      event: "node_repl.cua_broker.failed",
    });
  });
  server.listen(socketPath);
  server.unref();
  const ready = new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    connection: { socketPath, token },
    ready,
    close: async () => {
      await ready.catch(() => undefined);
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      if (input.platform !== "win32") await rm(socketPath, { force: true });
    },
  };
}

async function handleSocket(socket, runtime, token) {
  const abortController = new AbortController();
  let completed = false;
  let requestId;
  socket.on("error", () => {
    if (!completed) abortController.abort();
  });
  socket.once("close", () => {
    if (!completed) abortController.abort();
  });
  try {
    const raw = await readLine(socket, abortController.signal);
    const payload = JSON.parse(raw);
    assertToken(payload.token, token);
    if (typeof payload.id !== "string" || typeof payload.method !== "string") {
      throw new Error("Computer Use broker request is invalid");
    }
    requestId = payload.id;
    const context = parseContext(payload.context);
    const result = await runtime.execute({
      toolName: payload.method,
      arguments: payload.input,
      context,
      signal: abortController.signal,
    });
    completed = true;
    if (socket.writable) socket.end(`${JSON.stringify({ id: payload.id, ok: true, result })}\n`);
  } catch (error) {
    completed = true;
    if (socket.writable) {
      socket.end(
        `${JSON.stringify({ id: requestId ?? null, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
      );
    }
  }
}

function assertToken(actualValue, expectedValue) {
  if (typeof actualValue !== "string")
    throw new Error("Computer Use broker request is not authorized");
  const actual = Buffer.from(actualValue);
  const expected = Buffer.from(expectedValue);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Computer Use broker request is not authorized");
  }
}

function parseContext(value) {
  if (!value || typeof value !== "object")
    throw new Error("Computer Use request context is missing");
  const context = value;
  if (typeof context.sessionId !== "string" || !context.sessionId.trim()) {
    throw new Error("Computer Use request context is missing sessionId");
  }
  const workspacePath =
    typeof context.workspacePath === "string" ? context.workspacePath.trim() : "";
  const workspaceIdentity =
    typeof context.workspaceIdentity === "string" ? context.workspaceIdentity.trim() : "";
  const workspaceKey =
    (typeof context.workspaceKey === "string" ? context.workspaceKey.trim() : "") ||
    workspaceIdentity ||
    workspacePath;
  if (!workspaceKey) throw new Error("Computer Use request context is missing workspaceKey");
  return {
    sessionId: context.sessionId,
    runtimeScope: context.runtimeScope === "subagent" ? "subagent" : "main",
    workspaceKey,
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(typeof context.remoteSessionId === "string"
      ? { remoteSessionId: context.remoteSessionId }
      : {}),
    ...(typeof context.turnId === "string" ? { turnId: context.turnId } : {}),
    ...(context.clientMode === "web-remote-replayable" ||
    context.clientMode === "desktop-continuous"
      ? { clientMode: context.clientMode }
      : {}),
    ...(context.deliveryKind === "web-remote-replayable" ||
    context.deliveryKind === "desktop-continuous"
      ? { deliveryKind: context.deliveryKind }
      : {}),
    ...(context.trace && typeof context.trace === "object" ? { trace: context.trace } : {}),
  };
}

async function readLine(socket, signal) {
  return await new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        cleanup();
        reject(new Error("Computer Use broker request exceeded 1 MiB"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
