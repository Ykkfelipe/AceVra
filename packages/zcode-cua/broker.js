import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { DEV_CUA_HELPER_BUNDLE_ID, HELPER_BUNDLE_ID } from "./broker-helper-constants.js";

export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_TOKEN_ENV = "ZCODE_CUA_PERMISSION_BROKER_TOKEN";
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";
export const EXPECTED_HELPER_IDS_ENV = "ZCODE_CUA_EXPECTED_HELPER_IDS";

/**
 * The helper identities this build is willing to talk to.
 *
 * A socket path is not an identity: anything that can write into the runtime data root can bind
 * that path. The helper therefore reports the identity it verified for itself out of its own code
 * signature (`SecCodeCheckValidity` + `SecCodeCopySigningInformation`, see
 * `native/cua-helper/CodeIdentity.swift`), and this list is the external expectation that turns
 * that report into a check.
 *
 * What this list is, precisely: a **collision filter**, not an authenticity anchor. A signing
 * identifier is chosen by whoever signs the binary (`codesign -i …`), so a determined same-uid
 * attacker can mint a self-signed binary carrying one of these ids. What the list does buy is that
 * the product helper and the dev helper cannot be silently swapped for each other, that an
 * unrelated binary answering on our socket is refused, and that a helper whose own seal is broken
 * never gets this far. The checks carrying real weight are the helper's own signature validation
 * and the `grant_owner` cross-check in `assertHelperIdentity`. Anchoring the identity further — a
 * pinned certificate root or team id, or peer credentials the client can read for itself — needs a
 * launcher-supplied expectation and is deferred with the launcher; the spec says so explicitly.
 */
export const DEFAULT_EXPECTED_HELPER_IDENTIFIERS = Object.freeze([
  // Imported rather than retyped: a rename in the producer must not silently orphan this list.
  HELPER_BUNDLE_ID,
  DEV_CUA_HELPER_BUNDLE_ID,
]);

/**
 * Resolve the expected identities.
 *
 * An override that names nothing is treated as "not configured" rather than as "accept anything":
 * an empty list would otherwise disable the check entirely, which is the opposite of what the
 * escape hatch is for.
 */
export function resolveExpectedHelperIdentifiers(options = {}) {
  const env = options.env ?? process.env;
  const raw = env?.[EXPECTED_HELPER_IDS_ENV];
  if (typeof raw === "string" && raw.trim()) {
    const entries = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length > 0) return entries;
  }
  return [...DEFAULT_EXPECTED_HELPER_IDENTIFIERS];
}

/**
 * Whether a response must carry a verified helper identity.
 *
 * macOS only, because the check is a macOS code-signature check. The Windows development host is a
 * forked Node entry (`windowsCuaHelperHostSupport.ts`) with its own per-launch pipe and token
 * transport and no code signature at all, so requiring `helper_identity` there would turn every
 * health probe into a failure. The platforms that can answer the question are the ones asked.
 */
function defaultRequireVerifiedHelperIdentity(env) {
  const platform = env?.platform ?? process.platform;
  return platform === "darwin";
}

/**
 * Decide whether the identity a helper reported about itself may be trusted.
 *
 * Pure, so the policy is testable without a socket, and total: every rejection names a stable
 * code, because a caller has to distinguish "there is no helper" from "the thing answering is not
 * our helper".
 */
export function evaluateHelperIdentity(identity, expectedIdentifiers) {
  const expected = Array.isArray(expectedIdentifiers) ? expectedIdentifiers : [];
  if (expected.length === 0) {
    // Fail closed: an empty expectation must never come to mean "any identity".
    return {
      verified: false,
      code: "helper_identity_policy_missing",
      reason: "no expected helper identities are configured",
    };
  }
  if (!identity || typeof identity !== "object") {
    return {
      verified: false,
      code: "helper_identity_missing",
      reason: "the helper did not report a verified code identity",
    };
  }
  if (identity.verified !== true) {
    return {
      verified: false,
      code: "helper_identity_unverified",
      reason:
        typeof identity.reason === "string" && identity.reason
          ? `the helper failed its own signature check: ${identity.reason}`
          : "the helper failed its own signature check",
    };
  }
  const identifier = typeof identity.identifier === "string" ? identity.identifier : "";
  if (!identifier) {
    return {
      verified: false,
      code: "helper_identity_unverified",
      reason: "the helper's verified identity carries no signing identifier",
    };
  }
  if (identity.ad_hoc === true) {
    // An ad-hoc grant dies on the next rebuild (measured), so an ad-hoc helper in a path that
    // expects a stable identity is a misconfiguration, not a weaker-but-fine helper.
    return {
      verified: false,
      code: "helper_identity_adhoc",
      reason: `helper '${identifier}' is ad-hoc signed; a stable signing identity is required`,
    };
  }
  if (expected.length > 0 && !expected.includes(identifier)) {
    return {
      verified: false,
      code: "helper_identity_mismatch",
      reason:
        `helper signed as '${identifier}' is not one of the expected identities ` +
        `(${expected.join(", ")})`,
    };
  }
  return { verified: true, code: "ok", reason: "", identifier };
}

/**
 * Validate one broker response against the identity policy.
 *
 * Two things are checked, and the second is what makes `grant_owner` trustworthy downstream:
 * the response must carry a verified identity *and*, when it reports a `grant_owner`, that owner
 * must be the verified identifier. A response whose claim disagrees with its signature is refused
 * rather than passed on, so every consumer of `grant_owner` is reading a verified value even if it
 * never looks at the identity block itself.
 */
export function assertHelperIdentity(response, expectedIdentifiers) {
  const verdict = evaluateHelperIdentity(response?.helper_identity, expectedIdentifiers);
  if (!verdict.verified) {
    throw new BrokerError(verdict.reason, { code: verdict.code, details: verdict });
  }
  const claimedOwner = response?.grant_owner;
  if (typeof claimedOwner === "string" && claimedOwner && claimedOwner !== verdict.identifier) {
    throw new BrokerError(
      `the helper reports grant_owner '${claimedOwner}' but its signature says ` +
        `'${verdict.identifier}'`,
      { code: "helper_identity_mismatch" },
    );
  }
  return verdict;
}

export class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use broker is unavailable.");
    this.name = "BrokerError";
    this.code = options.code ?? "unavailable";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

const brokerErrorFactory = (code) => (message, details) =>
  new BrokerError(message ?? code, { code, details });

export const notAuthorized = brokerErrorFactory("not_authorized");
export const notSelectable = brokerErrorFactory("not_selectable");
export const notSettable = brokerErrorFactory("not_settable");
export const elementUnavailable = brokerErrorFactory("element_unavailable");
export const actionUnavailable = brokerErrorFactory("action_unavailable");
export const foregroundRequired = brokerErrorFactory("foreground_required");

/**
 * Broker method registry, and the single place method names are authorized.
 *
 * Semantic methods are explicitly enumerated; arbitrary input and unknown methods remain refused.
 */
const BROKER_METHOD_KINDS = Object.freeze({
  permission_status: "read",
  list_apps: "read",
  list_windows: "read",
  observe: "read",
  control_status: "read",
  press: "mutating",
  set_value: "mutating",
  acquire_control: "mutating",
  release_control: "mutating",
  activate_target: "mutating",
  move_pointer: "mutating",
  click: "mutating",
  type_text: "mutating",
  key_press: "mutating",
  scroll: "mutating",
  drag: "mutating",
});

export function isBrokerMethod(method) {
  return (
    typeof method === "string" && Object.prototype.hasOwnProperty.call(BROKER_METHOD_KINDS, method)
  );
}

export function isReadOnlyBrokerMethod(method) {
  return isBrokerMethod(method) && BROKER_METHOD_KINDS[method] === "read";
}

/**
 * Parse one request line. Never throws: a malformed line has to be answerable with a
 * `bad_request` response rather than being able to take the server down.
 */
export function parseRequestLine(line) {
  if (typeof line !== "string") return undefined;
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  if (typeof parsed.method !== "string" || parsed.method.length === 0) return undefined;
  return {
    id: typeof parsed.id === "string" ? parsed.id : null,
    method: parsed.method,
    params: parsed.params,
  };
}

export function okResponse(result) {
  return { ok: true, result };
}

export function errorResponse(message, options = {}) {
  return {
    ok: false,
    error: { message, ...(options.code ? { code: options.code } : {}) },
  };
}

export function errorResponseFromException(error) {
  const code =
    error && typeof error === "object" && typeof error.code === "string" ? error.code : undefined;
  return errorResponse(error instanceof Error ? error.message : String(error), { code });
}

export function serializeResponse(response) {
  return `${JSON.stringify(response)}\n`;
}

/** Dispatch one parsed request against a backend: a map of method name to handler. */
export async function dispatchRequest(backend, request) {
  if (!request || typeof request.method !== "string") {
    return errorResponse("request has no method", { code: "bad_request" });
  }
  if (!isBrokerMethod(request.method)) {
    return errorResponse(`method '${request.method}' is not available`, {
      code: "not_authorized",
    });
  }
  const handler = backend?.[request.method];
  if (typeof handler !== "function") {
    return errorResponse(`method '${request.method}' has no handler`, {
      code: "unsupported_method",
    });
  }
  try {
    return okResponse(await handler(request.params ?? {}, request));
  } catch (error) {
    return errorResponseFromException(error);
  }
}

export async function handleRequestLine(backend, line) {
  const request = parseRequestLine(line);
  if (!request) {
    return errorResponse("request line is not a JSON object", { code: "bad_request" });
  }
  return await dispatchRequest(backend, request);
}

/**
 * A unique socket path for one launch. Used by the Windows development host
 * (`windowsCuaHelperHostSupport.ts`), whose runtime owns its own socket per launch; left
 * unchanged by CUA-1.
 */
export function mintBrokerSocketPath(options = {}) {
  const dir = typeof options.dir === "string" ? options.dir : tmpdir();
  return join(dir, `zcode-cua-broker-${randomUUID()}.sock`);
}

/**
 * The socket the host and the Helper agree on: an explicit environment value wins, otherwise
 * the runtime's own data root.
 *
 * CUA-1 changes the fallback from a freshly minted random path to a stable one. Several
 * callers (`services/node.ts`) use this to *find* the running Helper, which a random path can
 * never do — it only ever describes a socket that does not exist yet. The Helper's own default
 * (`defaultBrokerSocketPath` in BrokerServer-adjacent Swift) matches this path exactly.
 */
export function resolveBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env[BROKER_SOCKET_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  const home =
    typeof env?.ZCODE_HOME === "string" && env.ZCODE_HOME.trim()
      ? env.ZCODE_HOME.trim()
      : join(homedir(), ".zcode");
  return join(home, "computer-use", "helper.sock");
}

function encodeRequestLine(method, params, id, token) {
  const request = { id: id ?? null, method };
  if (params !== undefined) request.params = params;
  // CUA-1.5: when the host launched a hardened session, agents carry the per-launch capability
  // token in their env; the host's relay checks it (constant-time) and strips it before the
  // Helper sees the request. Absent token = CUA-1 standalone behaviour, unchanged.
  if (token) request.token = token;
  return `${JSON.stringify(request)}\n`;
}

/**
 * Call one explicitly registered method on a running Helper.
 *
 * Every failure throws a `BrokerError` with a stable `code`, because callers must distinguish
 * "the grant is missing" from "the Helper is not running" to degrade accurately.
 *
 * The response is checked against the helper identity policy before it is returned, so a socket
 * answered by something that is not a helper this build expects is a failure and not a result.
 */
export async function callBrokerMethod(args) {
  const {
    socketPath,
    method,
    params,
    timeoutMs = 5000,
    requireVerifiedIdentity = defaultRequireVerifiedHelperIdentity(),
    expectedHelperIdentifiers = resolveExpectedHelperIdentifiers(),
    token = process.env?.[BROKER_TOKEN_ENV],
  } = args ?? {};
  if (typeof socketPath !== "string" || !socketPath) {
    throw new BrokerError("a broker socket path is required", { code: "no_socket" });
  }
  if (!isBrokerMethod(method)) {
    throw new BrokerError(`method '${method}' is not available`, {
      code: "not_authorized",
    });
  }
  if (process.env?.[BROKER_UNAVAILABLE_ENV]) {
    // Fail closed: an explicit unavailability marker means no request is attempted at all.
    throw new BrokerError("the Computer Use broker is marked unavailable", {
      code: "unavailable",
    });
  }

  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    let buffer = "";

    const settle = (settleWith, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      settleWith(value);
    };
    const timer = setTimeout(
      () => settle(reject, new BrokerError("broker request timed out", { code: "timeout" })),
      timeoutMs,
    );
    timer.unref?.();

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(encodeRequestLine(method, params, "1", token)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let response;
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch {
        settle(reject, new BrokerError("broker returned malformed JSON", { code: "bad_response" }));
        return;
      }
      if (response?.ok === true) {
        if (requireVerifiedIdentity) {
          try {
            assertHelperIdentity(response.result, expectedHelperIdentifiers);
          } catch (error) {
            settle(reject, error);
            return;
          }
        }
        settle(resolve, response.result);
        return;
      }
      const failure = response?.error;
      settle(
        reject,
        new BrokerError(
          typeof failure === "string" ? failure : (failure?.message ?? "broker request failed"),
          { code: failure?.code ?? "broker_error" },
        ),
      );
    });
    socket.on("error", (error) =>
      settle(
        reject,
        new BrokerError(`broker connection failed: ${error.message}`, {
          code: "connect_failed",
        }),
      ),
    );
  });
}

/**
 * Poll the Helper until it answers, then report the identity it verified for itself.
 *
 * Health is derived from `permission_status` rather than a dedicated ping, so the observe-only
 * method set stays exactly the four the spec names. `bundleId` is the *verified* signing
 * identifier, never the `grant_owner` string the helper typed into its own report, and never a
 * pid: the previous implementation of this function returned whatever the helper claimed.
 */
export async function probeHelperHealth(socketPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const perTryTimeoutMs = options.perTryTimeoutMs ?? 1000;
  const requireVerifiedIdentity =
    options.requireVerifiedIdentity ?? defaultRequireVerifiedHelperIdentity();
  const expectedHelperIdentifiers =
    options.expectedHelperIdentifiers ?? resolveExpectedHelperIdentifiers();
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const status = await callBrokerMethod({
        socketPath,
        method: "permission_status",
        timeoutMs: perTryTimeoutMs,
        requireVerifiedIdentity,
        expectedHelperIdentifiers,
      });
      // On macOS `callBrokerMethod` already rejected an unverified helper, so the identifier below
      // is verified there. A platform that opted out has no signature to verify, so the helper's own
      // report is all there is — the shape the Windows development host's ready gate consumes, which
      // wants a pid it can match against the child process it spawned.
      const identity = status?.helper_identity ?? {};
      const reportedPid = status?.identity?.pid;
      return {
        bundleId:
          typeof identity.identifier === "string"
            ? identity.identifier
            : typeof status?.grant_owner === "string"
              ? status.grant_owner
              : null,
        pid:
          typeof identity.pid === "number"
            ? identity.pid
            : typeof reportedPid === "number"
              ? reportedPid
              : null,
        verified: requireVerifiedIdentity ? true : undefined,
        identity,
      };
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw lastError ?? new BrokerError("helper health probe timed out", { code: "timeout" });
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
