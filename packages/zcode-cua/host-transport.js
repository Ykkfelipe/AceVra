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

export class CuaHostTransportError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "CuaHostTransportError";
    this.code = options.code ?? "unavailable";
  }
}

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

  const state = { helperConnected: false, admitted: null };

  function refuse(message, code) {
    return new CuaHostTransportError(message, { code });
  }

  /** One stable, path-free refusal on any relay surface (spec: no host paths in public errors). */
  function respondError(context, message, code) {
    context.respond(JSON.stringify({ ok: false, error: { message, code } }));
  }

  function failPending(code) {
    const waiting = pending;
    pending = new Map();
    for (const entry of waiting.values()) {
      entry.fail(refuse("the helper connection is no longer available", code));
    }
  }

  function dropHelper() {
    if (helperSocket) {
      const socket = helperSocket;
      helperSocket = null;
      socket.destroy();
    }
    state.helperConnected = false;
    state.admitted = null;
    failPending("helper_disconnected");
  }

  /** Dead session directories are pruned by the session module before a new one is created. */

  function handleHelperLine(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      // The Helper wrote something that is not one of ours: answer pending traffic honestly and
      // cut the connection rather than guessing (fail closed on malformed messages).
      dropHelper();
      return;
    }
    const id = typeof response?.id === "string" ? response.id : null;
    const entry = id ? pending.get(id) : undefined;
    if (!entry) return; // a response with no waiter (e.g. after a timeout) is dropped
    pending.delete(id);
    entry.respond(line);
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
      respondError(context, "the helper connection is not available", "helper_disconnected");
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
        respondError(context, error.message, error.code ?? "unavailable");
      },
    });
    try {
      if (!helperSocket || !helperSocket.writable) {
        throw refuse("the helper connection is not available", "helper_disconnected");
      }
      helperSocket.write(`${JSON.stringify(forwarded)}\n`);
    } catch (error) {
      pending.delete(internalId);
      respondError(context, error.message, error.code ?? "unavailable");
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

  /** One stable, path-free hello refusal (spec: no host paths, no token data in errors). */
  function refuseHello(socket, code, message) {
    if (socket.writable) {
      socket.write(`${JSON.stringify({ ok: false, error: { message, code } })}\n`);
    }
    socket.destroy();
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
    state.admitted = { pid: verdict.pid, identifier: verdict.identifier };
    helperSocket = socket;
    state.helperConnected = true;
    attachLineFraming(socket, remainder, MAX_RESPONSE_LINE_BYTES, handleHelperLine);
    socket.on("error", () => dropHelper());
    socket.on("close", () => {
      if (helperSocket === socket) dropHelper();
    });
  }

  /**
   * Newline framing shared by the client and helper roles: complete lines only, oversized
   * lines destroy the socket. `initial` carries bytes already received with the first line.
   */
  function attachLineFraming(socket, initial, maxBytes, onLine) {
    let buffer = initial;
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          if (Buffer.byteLength(buffer) > maxBytes) socket.destroy();
          return;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > maxBytes) {
          socket.destroy();
          return;
        }
        onLine(line);
      }
    });
  }

  function handleConnection(socket) {
    // One socket, two roles, decided by the first line (spec "Transport topology"): a `hello`
    // makes this connection a Helper candidate; anything else is a client request, which the
    // capability token gates. A helper candidate that fails admission never reaches dispatch.
    let undecided = true;
    let buffer = "";
    undecidedSockets.add(socket);
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!undecided) return; // role handlers own the socket after the first line
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(buffer) > MAX_REQUEST_LINE_BYTES) socket.destroy();
        return;
      }
      const line = buffer.slice(0, newline);
      const remainder = buffer.slice(newline + 1);
      undecided = false;
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
    });
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
      dropHelper();
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
