// CUA-4: renderer-facing Computer Use session read model and confined frame reads.
//
// The lease authority stays the single owner of session control state; this module only
// projects it for the owning UI and reconciles it against the Helper's own lease truth:
// while the authority still reports a lease `active`, one bounded read-only
// `control_status` query asks the Helper whether the lease has already ended (for example
// by physical user input). If the Helper reports a terminal state, the authority is
// released with the Helper's code (`interrupted` etc.) through the fenced, idempotent
// `release` — a concurrent Stop/pause or a new generation therefore always wins.
//
// Session isolation: another session's activity, observation or lease is never returned.
// Host frame paths never cross the renderer boundary — frames are fetched by observation
// id through `readComputerUseObservationFrame`, which resolves only under the accepted
// Helper observation roots and only for the session's own latest observation.

import { readFile, realpath, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";

import type {
  CuaComputerUseSessionView,
  CuaObservationFrameResult,
  CuaSessionActivityView,
  CuaSessionLeaseView,
} from "@zcode/zcode-cua/broker";

import type { LeaseAuthority, LeaseRecord } from "./lease-authority/contract.js";

/** The Helper answered `control_status`; its `lease_state` is the authoritative termination code. */
export interface ControlStatusProbe {
  queryControlStatus(params: { lease_id: string }): Promise<{
    lease_state?: string;
    [key: string]: unknown;
  }>;
}

export interface CuaSessionViewDeps {
  authority: LeaseAuthority | undefined;
  host: ControlStatusProbe | undefined;
}

const ACTIVE_STATES = new Set(["reserving", "active"]);

function leaseView(record: LeaseRecord | undefined, sessionId: string): CuaSessionLeaseView {
  if (!record || record.ownerSession !== sessionId) return { state: "inactive" };
  return {
    state: record.state,
    leaseId: record.leaseId,
    ...(Number.isFinite(record.generation) ? { generation: record.generation } : {}),
  };
}

/**
 * Builds the owner-session-filtered session view. When the authority still holds the lease
 * active, one bounded Helper `control_status` query reconciles a physical-input yield into the
 * authority so the UI sees it within this poll; a Helper-side failure leaves the view as-is
 * (presentation only — admission still gates every action).
 */
export async function describeComputerUseSession(
  deps: CuaSessionViewDeps,
  sessionId: string,
): Promise<CuaComputerUseSessionView> {
  const authority = deps.authority;
  if (!authority || !sessionId) return { present: false };
  const session = authority.getSession(sessionId);
  let record = authority.getStatus();
  // A session with no recorded activity that does not own the lease has nothing to show;
  // another session's lease is never even surfaced as "present".
  const ownsLease = record?.ownerSession === sessionId;
  if (!session && !ownsLease) return { present: false };

  // Reconcile: Helper truth first (read-only), then the fenced authority release.
  if (
    deps.host &&
    record &&
    record.ownerSession === sessionId &&
    record.state === "active" &&
    record.helperLeaseId
  ) {
    try {
      const status = await deps.host.queryControlStatus({ lease_id: record.helperLeaseId });
      const helperState = typeof status?.lease_state === "string" ? status.lease_state : undefined;
      // `active` and `unknown` are not terminal: only a positive Helper termination reconciles.
      if (helperState && helperState !== "active" && helperState !== "unknown") {
        await authority.release(record.leaseId, helperState);
      }
    } catch {
      // Best effort: the next poll retries; admission and the Helper's own rules stay authoritative.
    }
    record = authority.getStatus();
  }

  const termination = authority.getLastTermination();
  // The termination is only this session's fact while it still describes the record this
  // session owned; once another session owns the current record it is never shared.
  const ownTermination =
    record && record.ownerSession === sessionId && termination?.leaseId === record.leaseId
      ? termination
      : undefined;

  const lease = leaseView(record, sessionId);
  const activity: CuaSessionActivityView | undefined = session?.activity;
  const observation = session?.observation
    ? {
        id: session.observation.id,
        capturedAt: session.observation.capturedAt,
        ...(Number.isFinite(session.observation.width) ? { width: session.observation.width } : {}),
        ...(Number.isFinite(session.observation.height)
          ? { height: session.observation.height }
          : {}),
        ...(typeof session.observation.blank === "boolean"
          ? { blank: session.observation.blank }
          : {}),
        ...(session.observation.target ? { target: { ...session.observation.target } } : {}),
      }
    : undefined;
  // `framePath` is host-internal and must never cross the renderer boundary.
  const view: Extract<CuaComputerUseSessionView, { present: true }> = {
    present: true,
    sessionId,
    lease,
    paused: false,
    ...(observation ? { observation } : {}),
    stopMeaningful: ACTIVE_STATES.has(lease.state) || activity?.phase === "started",
  };
  if (ownTermination) {
    view.lease.termination = { ...ownTermination };
  }
  const admission = authority.getAdmission();
  view.paused = admission.paused;
  if (admission.pausedAt !== undefined) view.pausedAt = admission.pausedAt;
  if (activity) view.activity = { ...activity };
  return view;
}

export interface CuaPauseResumeDeps {
  authority: LeaseAuthority | undefined;
}

// ---------------------------------------------------------------------------
// Confined observation frame read.
// ---------------------------------------------------------------------------

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const OBSERVATION_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Accepted observation roots: the Helper launch contract writes frames under
 * `<ZCODE_HOME | HOME/.zcode>/computer-use/observations`. Nothing outside these roots is ever
 * resolved, regardless of what a session record carries.
 */
export function observationRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = [];
  const zcodeHome = env.ZCODE_HOME?.trim();
  if (zcodeHome) roots.push(join(zcodeHome, "computer-use", "observations"));
  const home = env.HOME?.trim();
  if (home) roots.push(join(home, ".zcode", "computer-use", "observations"));
  return [...new Set(roots)];
}

function unavailableFrame(
  code: NonNullable<CuaObservationFrameResult["code"]>,
): CuaObservationFrameResult {
  return { status: "unavailable", code };
}

export interface CuaFrameReadDeps {
  authority: LeaseAuthority | undefined;
  env?: NodeJS.ProcessEnv;
}

/**
 * Reads the session's own latest observation frame as PNG bytes.
 *
 * Every gate fails closed: the observation id must be this session's recorded latest
 * observation, the recorded frame file name must be exactly `<observationId>.png`, the real
 * path must resolve inside an accepted observation root, and the file must be a regular file
 * of at most 8 MiB with a PNG signature. A pruned or missing frame reports `stale`, not an
 * error, so the UI can keep showing the snapshot as stale. No capture is triggered here.
 */
export async function readComputerUseObservationFrame(
  deps: CuaFrameReadDeps,
  sessionId: string,
  observationId: string,
): Promise<CuaObservationFrameResult> {
  const authority = deps.authority;
  if (!authority || !sessionId || !OBSERVATION_ID_PATTERN.test(observationId)) {
    return unavailableFrame("forbidden");
  }
  const session = authority.getSession(sessionId);
  const observation = session?.observation;
  // Only this session's positively recorded latest observation is readable; an id belonging to
  // another session (or an older observation) is refused without touching the filesystem.
  if (!observation || observation.id !== observationId) return unavailableFrame("forbidden");
  const framePath = observation.framePath;
  if (!framePath) return unavailableFrame(observation.blank ? "stale" : "not_found");
  // The recorded frame must name exactly this observation; a framePath whose file name differs
  // (including any traversal tail) is refused before any filesystem resolution happens.
  if (basename(framePath) !== `${observationId}.png`) {
    return unavailableFrame("forbidden");
  }

  let resolved: string;
  try {
    const info = await stat(framePath);
    if (!info.isFile()) return unavailableFrame("not_found");
    if (info.size > MAX_FRAME_BYTES) return unavailableFrame("too_large");
    resolved = await realpath(framePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // Missing / pruned by the Helper is the ordinary stale case, not an exception dump.
    if (code === "ENOENT" || code === "ENOTDIR") return unavailableFrame("stale");
    return unavailableFrame("unavailable");
  }
  // Only real roots count: a root that does not resolve (yet) accepts nothing.
  const acceptedRoots: string[] = [];
  for (const root of observationRoots(deps.env)) {
    try {
      acceptedRoots.push(await realpath(root));
    } catch {
      // Root missing — nothing inside it can be accepted.
    }
  }
  const insideAcceptedRoot = acceptedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + sep),
  );
  if (!insideAcceptedRoot) return unavailableFrame("forbidden");

  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return unavailableFrame("stale");
    return unavailableFrame("unavailable");
  }
  if (bytes.byteLength > MAX_FRAME_BYTES) return unavailableFrame("too_large");
  // A frame that is not a PNG never reaches the renderer, whatever its extension claims.
  if (bytes.byteLength < PNG_SIGNATURE.length || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    return unavailableFrame("unavailable");
  }
  return {
    status: "available",
    mimeType: "image/png",
    bytesBase64: bytes.toString("base64"),
    byteLength: bytes.byteLength,
  };
}
