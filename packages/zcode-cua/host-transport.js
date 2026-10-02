// CUA-1.75 host-owned transport: the trusted host creates the endpoint, the Helper connects
// out, and the admitted connection is bound to the peer's native identity.
//
// Authority for every rule below: packages/zcode-cua/specs/computer-use.md, sections
// "CUA-1.5 — trusted helper transport and peer identity hardening" (the direction flip) and
// "CUA-1.75 — binding the admitted Helper connection to the native peer identity" (the
// admission chain). In one paragraph: a bound socket authenticates nobody, so the host owns
// the only listening socket (fresh 0700 session directory, 0600 socket, per-launch capability
// token) and the Swift Helper connects out and verifies the LISTENER's code signature against a
// launcher-pinned designated requirement before serving anything; and since a token plus a
// self-reported pid still cannot prove who is on the connection, the host now binds the
// accepted socket to the peer's kernel identity (audit token via the native probe), verifies
// that exact process instance's code signature against the pinned Helper requirement, and
// requires the peer's exec args to equal the launch contract this host minted. A same-uid
// claimant without the token, with the wrong code, quoting a borrowed pid, or carrying a
// different launch contract is refused at admission.
//
// This file is the relay runtime (session lifecycle, connection roles, request multiplexing).
// The admission policy and requirement discovery live in host-transport-policy.js so they stay
// pure and testable without sockets; the native probe spawn lives in host-transport-peer.js.
//
// Ownership map (one owner each, no second write path):
//   * this module owns the session (directory, socket, token, helper connection, relay queue);
//   * the Helper owns request admission on its one connection (host already verified);
//   * services owns when to start/stop a session and what goes into agent spawn env.
//
// Failure posture: fail closed. A hello that fails any check is answered with a stable code and
// disconnected; client requests without the launch token are refused; nothing here ever falls
// back to a weaker mode on its own (callers decide fallback, per the spec) — including when
// the native probe is missing or unverified: no probe, no binding, no admission.

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { isBrokerMethod } from "./broker.js";
import {
  evaluateHelperHello,
  HELLO_TYPE,
  hostConnectHelperArgv,
  preflightHello,
  tokensMatch,
} from "./host-transport-policy.js";
import { createPeerIdentityBinder } from "./host-transport-peer.js";
import { startSessionServer, stopSessionServer } from "./host-transport-session.js";
import {
  CuaHostTransportError,
  attachLineFraming,
  notSentDetails,
  refuseHello,
  relayFailureDetails,
  respondError,
  stampConnectionGeneration,
} from "./host-transport-frames.js";

/** Agent-facing env keys. The socket path existed in CUA-1; the token is CUA-1.5. Re-exported
 * from broker.js, which owns the env-name namespace, so importers have one source. */
export { BROKER_TOKEN_ENV } from "./broker.js";

/** The policy module is re-exported here so `@zcode/zcode-cua/broker/hostTransport` stays the
 * single import surface for the whole transport contract. */
export {
  buildHostConnectOpenArgs,
  evaluateHelperHello,
  HELLO_TYPE,
  helperArgvMatches,
  hostConnectHelperArgv,
  PEER_PROBE_IDENTIFIER,
  readDesignatedRequirement,
  tokensMatch,
  verifyPeerProbe,
} from "./host-transport-policy.js";

/** Client request lines share the Helper's 1 MiB line cap so the two ends agree. */
const MAX_REQUEST_LINE_BYTES = 1024 * 1024;
/** Responses flow through unmodified; the node_repl bridge's 32 MiB cap stays the ceiling. */
const MAX_RESPONSE_LINE_BYTES = 32 * 1024 * 1024;

export { CuaHostTransportError } from "./host-transport-frames.js";

/**
 * Create the host side of the hardened transport. One instance = one session. The session owns
 * exactly one Helper connection at a time; after it closes, a fresh hello may be admitted
 * (Helper restart), which is the reconnect path the spec requires.
 *
 * Nothing here launches the Helper: the caller owns the launch (`buildHostConnectOpenArgs`, in
 * the policy module) so process scheduling stays with services.
 */
export function createCuaBrokerHost(options = {}) {
  const dataRoot =
    typeof options.dataRoot === "string" && options.dataRoot.trim()
      ? options.dataRoot.trim()
      : join(
          typeof options.env?.ZCODE_HOME === "string" && options.env.ZCODE_HOME.trim()
            ? options.env.ZCODE_HOME.trim()
            : join(homedir(), ".zcode"),
        );
  const sessionsRoot = join(dataRoot, "computer-use", "sessions");
  const launchToken = randomBytes(32).toString("hex");
  const expectedHelperIdentifiers = options.expectedHelperIdentifiers ?? [];
  const launchContract = options.launchContract ?? {};

  // The default native binding: spawn the peer-identity probe with the accepted socket fd.
  // Tests and diagnostics replace the whole binder through `bindPeerIdentity`; either way
  // admission only ever sees a complete kernel binding report or nothing (fail closed).
  const defaultBinder = createPeerIdentityBinder({
    probePath: options.peerProbePath,
    requirement: launchContract.helperRequirement ?? "",
    gateRequirement: options.peerProbeRequirement,
  });
  const bindPeerIdentity = options.bindPeerIdentity ?? defaultBinder.bind;

  let sessionDir = null;
  let socketPath = null;
  let server = null;
  let stopped = false;

  /** @type {import("node:net").Socket | null} the admitted Helper connection */
  let helperSocket = null;
  /** @type {Map<string, {respond: (line: string) => void, fail: (error: Error) => void}>} */
  let pending = new Map();
  /** @type {import("node:net").Socket[]} token-authenticated client connections */
  let clients = [];
  /** @type {Set<import("node:net").Socket>} connections whose first line has not arrived */
  let undecidedSockets = new Set();
  let helperSequence = 0;

  // connectionGeneration：每准入一次 Helper 连接（含同一进程宽限期内重连）加一。它是原生租约的
  // 代际边界：旧代际的应答或租约绝不能作用于新代际的受保护会话（spec "Generation fencing"）。
  const state = {
    helperConnected: false,
    admitted: null,
    connectionGeneration: 0,
  };
  /** @type {{reason: string, at: number, connectionGeneration: number, inFlight: number} | null} */
  let lastHelperDrop = null;

  function refuse(message, code, details) {
    return new CuaHostTransportError(message, { code, details });
  }

  const notSent = () => notSentDetails(state.connectionGeneration);

  function failPending(code, extra = {}) {
    const waiting = pending;
    pending = new Map();
    for (const entry of waiting.values()) {
      entry.fail(refuse("the helper connection is no longer available", code, extra));
    }
  }

  /**
   * Drop the admitted Helper connection. `reason` is recorded (and reported through
   * `onHelperDrop`) because the installed 92454874 failure left no host-side trace of why the
   * connection ended: the Helper exits on host EOF, so an unexplained drop is an unexplained exit.
   */
  function dropHelper(reason = "socket_closed") {
    const hadHelper = Boolean(helperSocket) || state.helperConnected;
    helperSocket?.destroy();
    helperSocket = null;
    const connectionGeneration = state.connectionGeneration;
    const inFlight = pending.size;
    state.helperConnected = false;
    state.admitted = null;
    // 已转发但未应答的请求：Helper 可能已经执行，投递状态未知（helper_exited, delivery unknown）。
    failPending("helper_exited", { ...notSent(), delivery: "unknown" });
    if (!hadHelper) return;
    lastHelperDrop = { reason, at: Date.now(), connectionGeneration, inFlight };
    // 诊断回调不能影响传输：异步投递，异常不回流。
    const drop = lastHelperDrop;
    void Promise.resolve()
      .then(() => options.onHelperDrop?.(drop))
      .catch(() => undefined);
  }

  /** Dead session directories are pruned by the session module before a new one is created. */

  function handleHelperLine(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      // The Helper wrote something that is not one of ours: answer pending traffic honestly and
      // cut the connection rather than guessing (fail closed on malformed messages).
      dropHelper(line.length === 0 ? "empty_line" : "malformed_line");
      return;
    }
    const id = typeof response?.id === "string" ? response.id : null;
    const entry = id ? pending.get(id) : undefined;
    if (!entry) return; // a response with no waiter (e.g. after a timeout) is dropped
    pending.delete(id);
    // 代际戳：应答携带产生它的连接代际，运行时据此栅栏旧代际（spec "Generation fencing"）。
    entry.respond(JSON.stringify(stampConnectionGeneration(response, state.connectionGeneration)));
  }

  /**
   * Validate + forward one client request line. `context.respond(payloadLine)` receives raw
   * response JSON (no trailing newline); `context.pendingIds` scopes the in-flight internal id
   * so this caller's disconnect fails exactly its own pending requests. `trusted` marks the
   * host's own in-process calls (callMethod): same relay pipeline, capability gate elided
   * because the caller is the host itself.
   */
  function dispatchRequestLine(line, context, trusted = false) {
    const respond = (object) => context.respond(JSON.stringify(object));
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      respondError(context, "request line is not a JSON object", "bad_request");
      return;
    }
    // Session capability first: discovering the socket buys nothing (spec "Session
    // authentication"). The token is stripped here and never forwarded to the Helper.
    if (!trusted && !tokensMatch(request?.token, launchToken)) {
      const code =
        typeof request?.token === "string" ? "wrong_caller" : "missing_session_capability";
      respondError(
        context,
        code === "wrong_caller"
          ? "the presented session capability is not valid"
          : "the session capability token is required",
        code,
      );
      return;
    }
    const method = request?.method;
    // 持续像素读取仅供可信宿主的视觉适配器；模型客户端不能开启旁路捕获。
    if (method === "workspace_stream" && !trusted) {
      respondError(context, "workspace stream is host-only", "not_authorized");
      return;
    }
    // Defence in depth: the Helper enforces this allowlist too; refusing here keeps unregistered
    // names off the verified connection entirely.
    if (typeof method !== "string" || !isBrokerMethod(method)) {
      respondError(
        context,
        `method '${String(method)}' is not available in CUA-1 (observe-only)`,
        "not_authorized",
      );
      return;
    }
    if (!helperSocket || !helperSocket.writable) {
      // 没有转发：请求确定未送达 Helper，可在新代际安全重试。
      respondError(
        context,
        "the helper connection is not available",
        "helper_disconnected",
        notSent(),
      );
      return;
    }
    const internalId = `c${(helperSequence += 1)}`;
    const forwarded = { id: internalId, method };
    if (request.params !== undefined) forwarded.params = request.params;
    context.pendingIds.push(internalId);
    pending.set(internalId, {
      respond: (responseLine) => {
        context.pendingIds = context.pendingIds.filter((id) => id !== internalId);
        context.respond(responseLine);
      },
      fail: (error) => {
        context.pendingIds = context.pendingIds.filter((id) => id !== internalId);
        respondError(context, error.message, error.code ?? "unavailable", error.details ?? {});
      },
    });
    try {
      if (!helperSocket || !helperSocket.writable) {
        throw refuse("the helper connection is not available", "helper_disconnected", notSent());
      }
      helperSocket.write(`${JSON.stringify(forwarded)}\n`);
    } catch (error) {
      pending.delete(internalId);
      respondError(context, error.message, error.code ?? "unavailable", error.details ?? {});
    }
  }

  /** Client-role connection: every line is a token-gated request. */
  function becomeClient(socket, firstLine, remainder) {
    if (stopped) {
      // A client that arrived during or after teardown gets no session at all.
      socket.destroy();
      return;
    }
    const context = {
      pendingIds: [],
      respond: (payload) => {
        if (socket.writable) socket.write(`${payload}\n`);
      },
    };
    clients.push(socket);
    socket.on("close", () => {
      clients = clients.filter((candidate) => candidate !== socket);
      for (const id of context.pendingIds.splice(0)) {
        const entry = pending.get(id);
        if (entry) {
          pending.delete(id);
          entry.fail(refuse("the client connection closed", "connect_failed"));
        }
      }
    });
    socket.on("error", () => socket.destroy());
    const onLine = (line) => dispatchRequestLine(line, context);
    if (firstLine !== null) onLine(firstLine);
    attachLineFraming(socket, remainder, MAX_REQUEST_LINE_BYTES, onLine);
  }

  /** Helper-role admission, then response demultiplexing on the same connection. */
  async function admitHelper(socket, helloLine, remainder) {
    if (stopped || state.helperConnected) {
      // One Helper per session; re-admission happens only after the current one closed.
      socket.destroy();
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(helloLine);
    } catch {
      socket.destroy();
      return;
    }
    // Shape + token BEFORE the native binding: an unauthenticated peer must not be able to buy
    // subprocess work with a hello-shaped line. Pre-filter only — the full evaluation still
    // runs on the bound facts.
    if (!preflightHello(parsed, launchToken)) {
      refuseHello(
        socket,
        "wrong_helper_token",
        "the helper did not present this session's launch token",
      );
      return;
    }
    // The native binding (spec "Admission event order", step 4): this accepted socket's peer,
    // as the kernel names it (audit token), code-verified as the exact admitted Helper and
    // carrying this launch's contract. `null` (no binding, dead peer, unverified probe) is a
    // refusal below — never a weaker path.
    const peerBinding = await bindPeerIdentity(socket);
    let expectedHelperArgv = null;
    try {
      expectedHelperArgv = hostConnectHelperArgv({
        socketPath,
        launchToken,
        ...launchContract,
      });
    } catch {
      expectedHelperArgv = null; // an unpinned launch contract admits nothing (fail closed)
    }
    const verdict = evaluateHelperHello(
      parsed,
      {
        launchToken,
        expectedHelperIdentifiers,
        expectedHelperArgv,
      },
      peerBinding,
    );
    if (!verdict.admitted || stopped || state.helperConnected) {
      if (!verdict.admitted) refuseHello(socket, verdict.code, verdict.reason);
      else socket.destroy();
      return;
    }
    state.connectionGeneration += 1;
    state.admitted = {
      pid: verdict.pid,
      identifier: verdict.identifier,
      connectionGeneration: state.connectionGeneration,
    };
    helperSocket = socket;
    state.helperConnected = true;
    // 只有当前准入的连接能结束会话；每种结束都带原因记录（onHelperDrop）。
    const dropFor = (reason) => () => helperSocket === socket && dropHelper(reason);
    attachLineFraming(
      socket,
      remainder,
      MAX_RESPONSE_LINE_BYTES,
      handleHelperLine,
      dropFor("oversized_line"),
    );
    socket.on("error", dropFor("socket_error"));
    socket.on("close", dropFor("helper_closed"));
  }

  function handleConnection(socket) {
    // One socket, two roles, decided by the first line (spec "Transport topology"): a `hello`
    // makes this connection a Helper candidate; anything else is a client request, which the
    // capability token gates. A helper candidate that fails admission never reaches dispatch.
    let buffer = "";
    undecidedSockets.add(socket);
    // 修复依据（window host 崩溃：RangeError: Invalid string length）：首行判定后该监听器
    // 原先仍挂在 socket 上，且在 `if (!undecided) return` 之前先 `buffer += chunk`——Helper
    // 连接上之后的每个响应字节都被追加进这个再也不读的缓冲。observation 稀疏时察觉不到；
    // workspace_stream 以 ~12 Hz 回传 JPEG 后数分钟就撑到 V8 字符串上限，宿主进程崩溃，
    // 之后 Stop 等所有命令都无处送达。判定角色后立即摘掉本监听器，字节只归角色处理器所有。
    const onFirstData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(buffer) > MAX_REQUEST_LINE_BYTES) socket.destroy();
        return;
      }
      const line = buffer.slice(0, newline);
      const remainder = buffer.slice(newline + 1);
      buffer = "";
      socket.off("data", onFirstData);
      undecidedSockets.delete(socket);
      let helloShaped = false;
      try {
        helloShaped = JSON.parse(line)?.result?.type === HELLO_TYPE;
      } catch {
        helloShaped = false;
      }
      if (helloShaped) {
        void admitHelper(socket, line, remainder);
      } else {
        becomeClient(socket, line, remainder);
      }
    };
    socket.on("data", onFirstData);
    socket.on("error", () => socket.destroy());
  }

  return {
    /** The per-launch capability token. Only the owning host process and spawn env see it. */
    get token() {
      return launchToken;
    },
    get socketPath() {
      return socketPath;
    },
    get sessionDir() {
      return sessionDir;
    },
    get helperConnected() {
      return state.helperConnected;
    },
    get admittedHelper() {
      return state.admitted;
    },
    /** Current Helper connection generation (0 = never admitted). */
    get connectionGeneration() {
      return state.connectionGeneration;
    },
    /** Why the last admitted Helper connection ended, if one did. */
    get lastHelperDrop() {
      return lastHelperDrop;
    },

    async start() {
      if (stopped) throw refuse("the transport has been stopped", "unavailable");
      if (server) return;
      let started;
      try {
        started = await startSessionServer(sessionsRoot);
      } catch (error) {
        throw refuse(error.message, "no_socket");
      }
      server = started.server;
      socketPath = started.socketPath;
      sessionDir = started.sessionDir;
      server.on("connection", (socket) => handleConnection(socket));
    },

    /**
     * In-process call used by the owning host code (probe/status). Same relay pipeline; the
     * capability check is elided only because the caller IS the host.
     */
    callMethod(method, params, { timeoutMs = 8_000 } = {}) {
      if (!isBrokerMethod(method)) {
        return Promise.reject(
          refuse(`method '${method}' is not available in CUA-1 (observe-only)`, "not_authorized"),
        );
      }
      return new Promise((resolveCall, rejectCall) => {
        const context = { pendingIds: [] };
        const timer = setTimeout(() => {
          // Drop the in-flight entry: a late helper response must not find a waiter.
          for (const id of context.pendingIds.splice(0)) pending.delete(id);
          rejectCall(refuse("the helper did not answer in time", "timeout"));
        }, timeoutMs);
        timer.unref?.();
        const settle = (settleWith, value) => {
          clearTimeout(timer);
          settleWith(value);
        };
        dispatchRequestLine(
          JSON.stringify({ id: "host", method, ...(params !== undefined ? { params } : {}) }),
          {
            pendingIds: context.pendingIds,
            respond: (payload) => {
              let parsed;
              try {
                parsed = JSON.parse(payload);
              } catch {
                settle(rejectCall, refuse("broker returned malformed JSON", "bad_response"));
                return;
              }
              if (parsed?.ok === true) settle(resolveCall, parsed.result);
              else {
                settle(
                  rejectCall,
                  refuse(
                    parsed?.error?.message ?? "broker request failed",
                    parsed?.error?.code ?? "broker_error",
                    relayFailureDetails(parsed?.error),
                  ),
                );
              }
            },
          },
          true,
        );
      });
    },

    async stop() {
      stopped = true;
      dropHelper("host_stopped");
      for (const socket of [...undecidedSockets]) socket.destroy();
      undecidedSockets.clear();
      for (const client of clients.splice(0)) client.destroy();
      failPending("unavailable");
      const currentServer = server;
      const currentSocketPath = socketPath;
      const currentSessionDir = sessionDir;
      server = null;
      socketPath = null;
      sessionDir = null;
      await stopSessionServer(currentServer, currentSocketPath, currentSessionDir);
    },
  };
}
